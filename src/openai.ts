/**
 * OpenAI 兼容端点（供 AstrBot 等第三方接入）。
 * 鉴权：Authorization: Bearer <ASTROBOT_API_KEY>（与网页口令分离，可随时吊销）。
 * 注入：长期记忆 + 日期/节假日/天气；保留调用方自带的人格/系统消息。
 * 落库：只记录增量（最后一条 user 消息 + 本次回复），保证每日归档/提炼覆盖 AstrBot 对话。
 */
import { resolveRecall } from './memory-engine';
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Env } from './types';
import { buildPromptMemoryFor } from './memory-index';
import { shouldSkipMemoryRecall, buildMemoryPack, budgetFromPack  } from './context-pack';
import { consumePendingRecall, recordRecallUsage, rememberPendingRecall } from './memory-rehearsal';
import { fetchBiliMeta, findBiliUrl, formatBiliMeta } from './bili';
import { loadPersonaDoc } from './persona-doc';
import { buildSystemPromptSplit, normalizeChannel, buildLiveFacts, isNowFactQuestion, isSilentEnd, silentEndRule, stripSilentEndToken } from './prompt';
import { resolvePersona } from './persona';
import { ticWarning } from './voice';
import { stripLeadingTimeLabels } from './anti-ai-flavor';
import { hasEmoji, replaceFaceMarkers, stripEmoji } from './faces';
import { facetsFromValues, stageFor } from './relation-facets';
import { readRelationStageLevel } from './relation-stage';
import { budgetContext, clipCore, formatBudgetManifest } from './context-budget';
import { buildPersonaDriftLine, loadPersonaState } from './persona-drift';
import { beijingHour, beijingMonth, dateKeyInBeijing } from './date';
import { attachWeather, getOrCreateDayContext } from './context';
import { getMemory } from './memory';
import { fetchWeather } from './weather';
import {
  insertUserMessage,
  updateMessageContent,
  insertAssistantReply,
  latestMessage,
  compactHistoryMessage,
  groupTurns,
  historyRangeNote,
  withHistoryTimestamp,
  HISTORY_FILE_MAX_CHARS,
  HISTORY_MESSAGE_MAX_CHARS,
  type MessageRow,
} from './db';
import { promptFingerprint } from './prompt-fingerprint';
import { recordRequest } from './request-log';
import {
  buildHistorySlice,
  conversationGapNote,
  loadRecentRounds,
  resolveRecentRounds,
} from './recent-context';
import { calcCost, loadPricing, type TokenUsage } from './pricing';
import { completeDeepSeek, streamDeepSeek, type DeepSeekMessage } from './deepseek';
import { getTodaySummary, maybeSummarizeToday } from './summary';
import { recentTopicsBlock } from './topics';
import { getCachedTurn, putCachedTurn } from './cmid-cache';
import { recordCpuSample } from './engine-metrics';
import { maybePrewarmCaches } from './cache-warm';
import { expandVagueQuery, isMemoryQuestion, memoryAnswerHint } from './query-expand';
import { promisesBlock } from './memory-promises';
import { loadImageDataUrl, saveImageFromSource } from './media';
import { byteLength, parseRelationValues } from './memory-maintenance';
import { markProfileDirty } from './profile-cache';
import { readSessionFacts } from './session-facts';
import { buildCharacterCard } from './character-card';
import { facetsOf, processEmotionTurn } from './emotion-context';
import { moodFromVector } from './emotion-vector';
import { buildVoiceDirective, naggingComplaintNote, recentActions, recentOpeners, recentPhrases, selfRepeatScore, voiceModeOf } from './voice';
import { formatRecentMemoBlock, getRecentMemo, maybeRefreshRecentMemo } from './recent-memory';
import { embedTexts, extractPromptMemory, recallMemoryForChat, stripDuplicateRecall } from './memory-index';
import { loadMemoryChunks } from './memory-context-store';
import { expandLinkedChunks } from './memory-links';
import { formatMemoryChunks, rankMemoryChunks, shouldRecallMemory } from './memory-domain';
import { buildAttitudePolicy } from './attitude-policy';
import { packMemoryChunks } from './context-packer';
import { affectEngineFor, memoryEngineFor } from './engine-flags';
import { recordEngineMetric } from './engine-metrics';
import { logTrace, resolveRequestId } from './trace';
import { recordFiles, recentFilesBlock } from './recent-files';
import { gateDecision, markHeld, untilMs, type GateDecision } from './life/gate';
import { loadLifeBlocks } from './chat-blocks';

type AppEnv = { Bindings: Env; Variables: { requestId: string } };
export const openaiApp = new Hono<AppEnv>();

function openaiError(c: Context<AppEnv>, status: number, message: string) {
  return c.json(
    {
      error: { message, type: status === 401 ? 'authentication_error' : 'invalid_request_error' },
    },
    status as ContentfulStatusCode,
  );
}

type CachedTurn = {
  content: string;
  user_message_id?: number;
  assistant_message_id?: number;
  created_at?: string;
};

/** 同一个 client_message_id 的重试：直接回放上次结果，不再落库/计费。 */
function cachedTurnResponse(c: Context<AppEnv>, content: string, stream: boolean) {
  if (stream) {
    const payload =
      `data: ${JSON.stringify({
        choices: [{ index: 0, delta: { content }, finish_reason: null }],
      })}\n\n` + 'data: [DONE]\n\n';
    return c.body(payload, 200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
    });
  }
  return c.json({
    id: `cached-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: c.env.DEEPSEEK_MODEL,
    choices: [
      { index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' },
    ],
    usage: null,
  });
}

export async function checkBearer(c: Context<AppEnv>): Promise<boolean> {
  const expected = c.env.ASTROBOT_API_KEY;
  const auth = c.req.header('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) return false;
  if (expected && token === expected) return true;
  // DS-Mobile 设备 Token：配对后写入 KV，允许调用 OpenAI 兼容端点
  const device = await c.env.KV.get(`app:device:${token}`).catch(() => null);
  return device !== null;
}

/** 提取消息中的纯文本（content 为 string，或 [{type:'text',text}] 数组）。 */
export function extractText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = (content as Array<{ type?: unknown; text?: unknown }>)
      .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text as string)
      .join('\n');
    return parts.length > 0 ? parts : null;
  }
  return null;
}

/** 解析二维码消息 content：字符串，或 [{type:'text',text}, {type:'image_url',image_url:{url}}] 数组。 */
export function parseContentParts(content: unknown): { text: string; images: string[] } | null {
  if (typeof content === 'string') return { text: content, images: [] };
  if (Array.isArray(content)) {
    const texts: string[] = [];
    const images: string[] = [];
    for (const p of content as Array<{ type?: unknown; text?: unknown; image_url?: { url?: unknown } }>) {
      if (!p) continue;
      if (p.type === 'text' && typeof p.text === 'string') texts.push(p.text);
      else if (p.type === 'image_url' && typeof p.image_url?.url === 'string') images.push(p.image_url.url);
    }
    if (texts.length === 0 && images.length === 0) return null;
    return { text: texts.join('\n'), images };
  }
  return null;
}

/** 去掉 AstrBot 追加的 <system_reminder>…</system_reminder> 元信息（保留真实消息内容）。 */
export function stripSystemReminder(content: string): string {
  return content
    .replace(/<system_reminder>[\s\S]*?<\/system_reminder>/gi, '')
    .replace(/<system_reminder>[\s\S]*$/i, '') // 未闭合的也去掉
    .trim();
}

/**
 * 去掉 AstrBot 注入的图片占位文本（这些是平台内部路径，用户不可见也不该出现在聊天记录里）。
 * 形如：`[Image 1: original path /root/data/temp/xxx.jpg]`、`[图片]`
 */
export function stripImagePlaceholders(content: string): string {
  return content
    .replace(/\[Image\s*\d*\s*:\s*original path[^\]]*\]/gi, '')
    .replace(/\[Image\s*\d*\s*:\s*[^\]]*\]/gi, '')
    .replace(/^\s*\[图片\]\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 把一段新内容拼回原位：与前后文本之间最多保留一个换行，不产生额外空行。 */
function joinBlock(before: string, block: string, after: string): string {
  const left = before.replace(/\s+$/, '');
  const right = after.replace(/^\s+/, '');
  const mid = block.trim();
  if (!mid) return left && right ? `${left}\n${right}` : left + right;
  if (!left) return right ? `${mid}\n${right}` : mid;
  if (!right) return `${left}\n${mid}`;
  return `${left}\n${mid}\n${right}`;
}

/**
 * 去掉 AstrBot 的「文件附件」包装。
 *
 * 用户在 QQ 里发一个文本文件时，平台会把内容包成：
 *   <attachment>
 *   [File Attachment: name 使用方法(1).txt, path /root/data/temp/xxx.txt]
 *   <file_content>
 *   …真实内容…
 *   </file_content>
 *   (以上是用户本轮发来的文件内容，请据此回答；…)
 *   </attachment>
 * 这些都是给模型的元信息，原样落库会让网页聊天记录里出现一大段噪音，
 * 所以只保留 <file_content> 里的真实内容。
 */
export function stripAttachmentWrapper(content: string): string {
  let text = content.replace(/\r\n/g, '\n');

  // ① 逐个取出 <attachment>…</attachment>，只保留 <file_content> 内部
  //    （用循环而不是一次性 replace，便于处理未闭合/嵌套不全的情况）
  for (let guard = 0; guard < 10; guard++) {
    const start = text.search(/<attachment>/i);
    if (start === -1) break;
    const closeRe = /<\/attachment>/gi;
    closeRe.lastIndex = start;
    const close = closeRe.exec(text);
    const end = close ? close.index + close[0].length : text.length;
    const body = /<file_content>([\s\S]*?)<\/file_content>/i.exec(text.slice(start, end));
    text = joinBlock(text.slice(0, start), body ? body[1] : '', text.slice(end));
  }

  // ② 没有 attachment 包裹、只剩 file_content 标签的情况
  text = text.replace(/<\/?file_content>/gi, '');

  // ③ 元信息行：[File Attachment: name …, path …]
  text = text.replace(/^\[File Attachment:[^\n]*\]\s*$/gim, '');

  // ④ 平台追加的指令行（半角/全角括号都处理）
  text = text.replace(/^[(（][^\n]*以上是用户本轮发来的文件内容[^\n]*[)）]\s*$/gim, '');

  return text
    .replace(/\[END\]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 去掉平台注入的 <system_notice>…</system_notice>（如图片蒙太奇说明）。 */
export function stripSystemNotice(content: string): string {
  return content
    .replace(/<system_notice>[\s\S]*?<\/system_notice>/gi, '')
    .replace(/<system_notice>[\s\S]*$/i, '') // 未闭合的也去掉
    .trim();
}

/** 统一的用户文本清洗链：平台元信息 → 附件包装 → 图片占位。 */
export function cleanUserText(text: string): string {
  return stripAttachmentWrapper(stripImagePlaceholders(stripSystemNotice(stripSystemReminder(text))));
}

/**
 * 动图蒙太奇：给模型补一句中文交代。
 *
 * 客户端会把动图抽帧、拼成一张「多帧并排」的大图（附一句英文 system_notice）。
 * 实测光说“只看第一帧”不够——模型仍会顺带描述变暗/重复的副本，所以明确要求忽略。
 */
export function withMontageHint(cleaned: string, raw: string): string {
  if (!/animation\s+montage/i.test(raw)) return cleaned;
  return (
    cleaned +
    '\n（这是动图抽帧拼成的一张图：画面里可能有并排、重复或变暗的副本。' +
    '把它当成一张普通照片，只描述第一个完整画面，不要提帧、拼图或重复部分。）'
  );
}

/**
 * 组装「最后一条用户消息」发给模型的内容（纯函数，可单测）。
 *
 * ★ 带图片时也必须用 withMontageHint 的结果，否则蒙太奇提示会被丢掉
 *   （之前就是这个 bug：图片分支用的是未加提示的清洗文本，提示从未发出去）。
 */
export function buildLastUserContent(
  cleaned: string,
  raw: string,
  images: Array<{ type: 'image_url'; image_url: { url: string } }>,
): DeepSeekMessage['content'] {
  const text = withMontageHint(cleaned, raw);
  if (images.length === 0) return text;
  return text ? [{ type: 'text', text }, ...images] : images;
}

/**
 * 语音标记写了开头引号却没写收尾时补上。
 *
 * 2026-11-09：模型发过「…不许得寸进尺[语音]「我好想你行了吧。……别笑，本小姐就这一次。」
 * 少了收尾的「」」，网页端要求成对，于是整条退化成裸文本（App 有兜底，所以只有网页露馅）。
 * 这里按行处理：语音块本来就不跨行，补在行尾即可。
 */
export function repairVoiceQuote(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const m = /[\[【［]\s*(?:语音消息|语音|voice)\s*[\]】］]\s*[「“]/.exec(line);
      if (!m) return line;
      const at = m.index + m[0].length;
      const close = line[at - 1] === '「' ? '」' : '”';
      if (line.indexOf(close, at) >= 0) return line;
      return line.replace(/\s+$/, '') + close;
    })
    .join('\n');
}

/**
 * 落库前归一化助手的回复文本。
 *
 * 客户端靠 `[语音]` / `[face:名字]` 这些纯文本标记决定「发语音 / 发表情」，
 * 但它们是给机器看的协议，原样入库会：
 *   1. 在网页聊天记录里显示成 `[语音]晚安…`；
 *   2. 被每日归档 / 记忆提炼当成正文读进 memory.md。
 * 所以入库时把语音换成可读的「（语音）」，表情标记直接去掉。
 * （实时回复仍然带标记，客户端要拿它去合成语音。）
 */
export function normalizeAssistantText(text: string): string {
  let out = repairVoiceQuote(text)
    .replace(/^\s*\[(?:语音|voice)\]\s*/i, '（语音）')
    // 表情标记换成 emoji 再入库（[face:敲打] 和直接写 [敲打] 两种都处理）
    .replace(/\[face[:：][^\]]{1,12}\]/g, (m) => replaceFaceMarkers(m));
  // 模型偶尔会模仿历史时间标签，把回复开头的时间戳去掉
  out = replaceFaceMarkers(out);
  out = stripLeadingTimeLabels(out).trim();
  // 同理：历史里曾带「他：」「你：」，模型会照着写在开头；现在历史不再带标签，
  // 但线上出现过「🙂你：……」这种表情在前、冒号在后的漏网（2026-11-06），所以放宽到「前 12 个非字母数字字符」
  for (let i = 0; i < 3; i += 1) {
    const next = out.replace(/^[^\p{L}\p{N}]{0,12}?(?:他|你)：\s*/u, '');
    if (next === out) break;
    out = next;
  }
  out = out.trim();
  // 模型偶发孤立代理项（\ud83d 之类），落库/发送前清掉
  out = out
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '')
    .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
  return stripSilentEndToken(out.replace(/[ \t]{2,}/g, ' '));
}

/** 是否为主动/定时任务触发的请求（这类消息不进入聊天历史与记忆，只用于生成回复）。 */
export function isProactiveRequest(content: string): boolean {
  return (
    /CRON JOB CONTEXT/i.test(content) ||
    /scheduled task/i.test(content) ||
    /You are now responding to a scheduled task/i.test(content)
  );
}

/** 提取消息纯文本（用于落库）。 */
function contentToText(content: DeepSeekMessage['content']): string {
  if (typeof content === 'string') return content;
  return content
    .filter((p) => p.type === 'text')
    .map((p) => (p as { text: string }).text)
    .join('\n');
}

/** 消息是否包含图片。 */
function contentHasImage(content: DeepSeekMessage['content']): boolean {
  return Array.isArray(content) && content.some((p) => p.type === 'image_url');
}

openaiApp.get('/models', async (c) => {
  if (!(await checkBearer(c))) return openaiError(c, 401, '无效的 API Key');
  return c.json({
    object: 'list',
    data: [{ id: c.env.DEEPSEEK_MODEL, object: 'model', created: 0, owned_by: 'deepseek' }],
  });
});

openaiApp.post('/chat/completions', async (c) => {
  if (!(await checkBearer(c))) return openaiError(c, 401, '无效的 API Key');
  const requestId = c.get('requestId') || resolveRequestId(c.req.header('x-request-id'));
  const body = (await c.req.json().catch(() => null)) as {
    messages?: unknown;
    stream?: unknown;
    max_tokens?: unknown;
    tools?: unknown;
    inject_history?: unknown;
    files?: unknown;
    /** 客户端已直传 R2 的原图 key（如大 GIF），只记录不重复上传 */
    image_keys?: unknown;
    /** 客户端已直传 R2 的语音 key（QQ 语音转 MP3） */
    audio_keys?: unknown;
    /** false = 这轮不要写进聊天记录（指令类消息） */
    record?: unknown;
    /** App 幂等键；同一 id 的重试直接回放上次回复 */
    client_message_id?: unknown;
  } | null;
  const rawMessages = body?.messages;
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
    return openaiError(c, 400, 'messages 不能为空');
  }
  // 冷启动时预热召回缓存（每小时最多一次，不阻塞回复）
  c.executionCtx.waitUntil(maybePrewarmCaches(c.env, c.executionCtx, new Date()));
  const prepT0 = performance.now();
  const clientMessageId =
    typeof body?.client_message_id === 'string' &&
    body.client_message_id.trim().length > 0 &&
    body.client_message_id.trim().length <= 100
      ? body.client_message_id.trim()
      : '';
  // 去重键在 D1（原 KV 每发一条就要写一次，免费版 1000 写/天很容易打满）
  const cmidKey = clientMessageId;
  if (cmidKey) {
    const cached = await getCachedTurn(c.env, cmidKey);
    if (cached && typeof cached.content === 'string' && cached.content) {
      return cachedTurnResponse(c, cached.content, body?.stream !== false);
    }
  }

  // 1) 转消息（保留文本与图片；图片以 OpenAI image_url 原样透传，deepseek-flash 支持图像理解）
  const textMessages: DeepSeekMessage[] = [];
  for (const m of rawMessages as Array<{ role?: unknown; content?: unknown }>) {
    const parts = parseContentParts(m?.content);
    if (parts === null) continue;
    const role: 'system' | 'user' | 'assistant' =
      m?.role === 'assistant' ? 'assistant' : m?.role === 'system' ? 'system' : 'user';
    const text = parts.text.slice(0, 20000);
    const content: DeepSeekMessage['content'] =
      parts.images.length === 0
        ? text
        : [
            ...(text ? [{ type: 'text' as const, text }] : []),
            ...parts.images.map((url) => ({ type: 'image_url' as const, image_url: { url } })),
          ];
    textMessages.push({ role, content });
  }

  // 1.5) 找到最后一条用户消息，先清洗平台包装（system_reminder / 附件 / 图片占位）。
  //      清洗后的文本既用于落库，也用于发给模型 —— 否则网页聊天记录里会出现一大段元信息。
  const lastUserIndex = (() => {
    for (let i = textMessages.length - 1; i >= 0; i--) {
      if (textMessages[i].role === 'user') return i;
    }
    return -1;
  })();
  const lastUser = lastUserIndex >= 0 ? textMessages[lastUserIndex] : undefined;
  const lastUserText = lastUser ? contentToText(lastUser.content) : '';
  const lastUserHasImage = lastUser ? contentHasImage(lastUser.content) : false;
  const lastUserCleaned = cleanUserText(lastUserText);
  // ★ 客户端对 /指令 类消息传 record=false：只回答，不写库（否则指令和它的回复会污染记忆）
  const noRecord = body?.record === false;
  const skipRecording =
    noRecord || (!lastUserCleaned && !lastUserHasImage) || isProactiveRequest(lastUserCleaned);

  // 把清洗结果写回上游消息（保留图片部分）
  if (lastUser) {
    const images = Array.isArray(lastUser.content)
      ? lastUser.content.filter(
          (p): p is { type: 'image_url'; image_url: { url: string } } => p.type === 'image_url',
        )
      : [];
    lastUser.content = buildLastUserContent(lastUserCleaned, lastUserText, images);
  }

  if (!textMessages.some((m) => m.role === 'user')) {
    return openaiError(c, 400, '缺少用户消息');
  }

  // 渠道：客户端用 X-Client-Channel 声明。App 两个请求方法都会带上它；
  // 旧版 App 没带，只有 X-Client-Voice —— 那就按手机端算，别再落到 AstrBot。
  // 这条兜底很重要：以前默认值直接是 'astrobot'，于是手机发的消息在库里全成了「QQ」。
  const declaredChannel = c.req.header('x-client-channel');
  const channel = normalizeChannel(
    declaredChannel ?? (c.req.header('x-client-voice') === '1' ? 'mobile' : undefined),
    'astrobot',
  );
  // 客户端声明了支持语音，才告诉模型可以发 [语音]（没装 TTS 的客户端不会收到这句提示）
  const voiceReply = c.req.header('x-client-voice') === '1';

  // ★ 先落库，再组装提示词（2026-11-06）。
  //   手机端的「发送中」只等这一行进 D1；以前插在提示词组装之后，
  //   用户要白白多等 1~3 秒（记忆包 + 召回都排在中间）。
  const nowForStore = new Date();
  const earlyImageKeys = Array.isArray(body?.image_keys)
    ? (body.image_keys as unknown[]).filter(
        (k): k is string => typeof k === 'string' && k.startsWith('images/') && k.length <= 200,
      )
    : [];
  const earlyAudioKeys = Array.isArray(body?.audio_keys)
    ? (body.audio_keys as unknown[]).filter(
        (k): k is string => typeof k === 'string' && k.startsWith('audio/') && k.length <= 200,
      )
    : [];
  const earlyContent = [
    lastUserCleaned,
    ...earlyImageKeys.map((k) => `[图片:${k}]`),
    ...earlyAudioKeys.map((k) => `[语音:${k}]`),
  ]
    .filter(Boolean)
    .join('\n');

  let userMessageId: number | undefined;
  let storedEarly = false;
  if (!skipRecording && earlyContent) {
    const latest = await latestMessage(c.env);
    if (latest && latest.role === 'user' && latest.content === earlyContent) {
      userMessageId = latest.id; // 重试请求：复用已存在的这一轮
    } else {
      const saved = await insertUserMessage(c.env, earlyContent, nowForStore, {
        channel,
        clientMessageId: clientMessageId || undefined,
      });
      userMessageId = saved.id;
      storedEarly = true;
      await markProfileDirty(c.env).catch(() => {});
    }
  }

  // ★ 消息闸门（P2）：她忙/在睡时先落库不回，到点由 cron 或 App 拉。
  // 放在这里而不是生成前：闸门只需要一次 KV 读，held 也能立刻返回。
  if (!skipRecording && userMessageId && earlyContent) {
    const gate: GateDecision = await gateDecision(c.env, nowForStore).catch(() => ({ hold: false }));
    if (gate.hold) {
      await markHeld(c.env, userMessageId, untilMs(nowForStore, gate.until ?? '08:00'));
      return c.json({
        held: true,
        until: gate.until,
        reason: gate.reason,
        user_message_id: userMessageId,
      });
    }
  }

  // 2) 注入长期记忆与当天上下文（保留 AstrBot 自带的人格/系统消息）
  const now = new Date();
  const dateKey = dateKeyInBeijing(now);
  c.executionCtx.waitUntil(maybeSummarizeToday(c.env, dateKey)); // 异步滚动摘要，不阻塞
  c.executionCtx.waitUntil(maybeRefreshRecentMemo(c.env, now)); // 异步刷新中期记忆（最近 24h）
  // 这些读取互不依赖：并行发起，减少 QQ 场景的首字延迟。
  let packMs = 0;
  const packT0 = performance.now();
  const [pack, facts] = await Promise.all([
    (async () => {
      const t0 = performance.now();
      const result = await buildMemoryPack(c.env, now, { channel: 'astrobot', ctx: c.executionCtx });
      packMs = performance.now() - t0;
      return result;
    })(),
    readSessionFacts(c.env, now, dateKey, storedEarly ? (userMessageId ?? null) : null),
  ]);
  c.executionCtx.waitUntil(recordCpuSample(c.env, channel, 'pack_ms', packMs).catch(() => {}));
  const { memory, dayCtxFile: dayCtx, weather, ctx, promptMemory, personaState } = pack;
  // 拉取失败时回退当天缓存，避免“没有天气”时模型去翻旧记忆
  if (pack.weather) await attachWeather(c.env, dateKey, pack.weather, dayCtx);
  const recentMemo = pack.recentMemo;
  // 文件沉淀：先记账再读，本轮发的文件立刻能出现在提示词里
  await recordFiles(c.env, body?.files);
  const recentFiles = await recentFilesBlock(c.env, now);
  // 中期记忆存在时跳过今日摘要，避免重复注入同一段时间的事
  const todaySummary = pack.todaySummary;
  const relation = parseRelationValues(memory);
  const envHour = beijingHour(now);
  const envMonth = beijingMonth(now);
  // 上一轮提过的往事被确认了吗
  void consumePendingRecall(c.env, lastUserCleaned, now.getTime()).catch(() => {});

  // ★ 情感系统：事件 → 情绪向量 → 5 轴微增量 → 情绪快照（先算，心情由它派生）
  const emotion = await processEmotionTurn({
    env: c.env,
    now: now.getTime(),
    base: facetsOf(relation),
    userText: lastUserCleaned,
    environment: {
      hour: envHour,
      isRestDay: dayCtx.is_holiday,
      weather,
      month: envMonth,
    },
    wasIgnored: facts.wasIgnored,
    // 探针/回归不记账：11-08 有 31 条同样的「我最近在焦虑什么」把关系值刷高了一大截
    noPersist: noRecord,
  });
  // Phase 3：态度策略影子/新引擎。默认 legacy，不改变回复。
  const affectEngine = affectEngineFor(c.env, channel);
  let attitude = emotion.snapshot;
  if (affectEngine === 'shadow' || affectEngine === 'next') {
    const startedAt = performance.now();
    const policy = buildAttitudePolicy({
      facets: emotion.facets,
      vector: emotion.state.vector,
      events: emotion.state.events,
      now: now.getTime(),
      wasIgnored: facts.wasIgnored,
    });
    const policyMs = Math.round(performance.now() - startedAt);
    logTrace('affect.policy', {
      requestId,
      engine: affectEngine,
      archetype: policy.archetype,
      tone: policy.tone,
      directives: policy.directives.length,
      policyMs,
    });
    await recordEngineMetric(c.env, {
      channel,
      kind: 'affect',
      mode: affectEngine,
      oldItems: 0,
      newItems: policy.directives.length,
      oldBytes: 0,
      newBytes: byteLength(policy.text),
      ms: policyMs,
      now: now.getTime(),
    });
    if (affectEngine === 'next') attitude = policy.text;
  }

  // ★ 心情值不再单独维护：由情绪向量派生，保证只有一份真相
  const effectiveMood = moodFromVector(emotion.state.vector);
  // ★ 活人感：状态卡 + 口语化（AstrBot 落库在 send 之前，故此处查询的是落库前的状态）
  const stageLevel = await readRelationStageLevel(c.env).catch(() => null);
  const charCard = buildCharacterCard({
    hour: envHour,
    hoursSinceLastContact: facts.hoursSinceLastContact,
    mood: effectiveMood,
    affinity: relation.affinity,
    intimacy: relation.intimacy,
    todayTurns: facts.todayTurns,
    dateKey,
    wasIgnored: facts.wasIgnored,
    ignoredMessage: facts.ignoredMessage,
    characterName: c.env.CHARACTER_NAME,
    stage: stageFor(facetsFromValues(relation), stageLevel ?? undefined),
  tone: resolvePersona(c.env).tone,
});
  const cardTextWithMood = charCard.cardText;
  // 自适应加载最近历史：默认 15 轮，技术/项目 30 轮，明确指代前文最多 50 轮。
  // QQ/App 客户端只发当前一条，历史必须从 D1/归档补。
  let historyRaw: MessageRow[] = [];
  let historyMessages: DeepSeekMessage[] = [];
  let historyNote: string | null = null;
  if (body?.inject_history === true && !skipRecording) {
    const historyRounds = resolveRecentRounds(lastUserCleaned);
    historyRaw = await loadRecentRounds(c.env, historyRounds, now);
    // 当前这条已经先落库了：历史统计和注入都要把它排除，否则会出现「最近 1 轮」但数组是空的
    if (userMessageId) historyRaw = historyRaw.filter((m) => m.id !== userMessageId);
    // 再兜一层：客户端这次发的话如果已经在 D1 里，注入时去掉最后一次
    const historyRows = historyRaw.filter(
      (m, i) =>
        !(i === historyRaw.length - 1 && m.role === 'user' && m.content === lastUserCleaned),
    );
    // 按轮数之外再加字符预算，防止 50 轮里塞进大段 B 站资料/文件。
    // 30 轮短句大约 6~9k 字符；以前超预算按「单条消息」shift，会把一轮拆成半轮，
    // 现在整轮切：原文保留最近的，更早的压成提要（一行一轮）跟着历史说明一起注入。
    const historyBudget =
      historyRounds >= 60 ? 20_000 : historyRounds >= 30 ? 14_000 : 10_000;
    const slice = buildHistorySlice(historyRows, {
      fullTurns: historyRounds,
      maxChars: historyBudget,
    });
    historyRaw = slice.rows;
    // ★ 同一条链接/内容他又发了一次：明确告诉她「你看过」，否则她会把同一段视频当新的、
    //   再演一遍「整个人凑到屏幕前」，看起来就像完全不记得刚才聊过（2026-11-07）。
    const repeatNote = repeatedContentNote(historyRaw, lastUserCleaned, now);
    historyNote = [
      repeatNote,
      historyRangeNote(historyRaw, now, slice.rounds - slice.fullRounds),
      conversationGapNote(historyRaw, now),
      slice.brief,
    ]
      .filter(Boolean)
      .join('\n');
    historyMessages = historyRaw
      .filter((m) => m.content.trim())
      .map((m) => ({
        role: m.role === 'assistant' ? ('assistant' as const) : ('user' as const),
        content: withHistoryTimestamp(compactHistoryMessage(
            m.content, m.content.includes('【文件：') ? HISTORY_FILE_MAX_CHARS : HISTORY_MESSAGE_MAX_CHARS,
          ),
          m.created_at),
      }));
  }
  // 召回 query：当前消息 + 最近 3 条用户历史（按时间从旧到新）
  const recallQuery = [
    lastUserCleaned,
    ...historyRaw.filter((m) => m.role === 'user').slice(-3).map((m) => m.content),
    ...textMessages
      .filter((m) => m.role === 'user')
      .slice(-3, -1)
      .map((m) => contentToText(m.content)),
  ].join(' ');
  const focus = [
    lastUserCleaned,
    ...historyMessages.map((m) => (typeof m.content === 'string' ? m.content : contentToText(m.content))),
  ].join(' ');
  const memoryEngine = memoryEngineFor(c.env, channel);
  const recallT0 = performance.now();
  // 模糊指代先展开（「那个项目」→ 具体那件事的关键词），只在有指代时才多读一次记忆
  const expanded = await expandVagueQuery(c.env, lastUserCleaned, recallQuery).catch(() => ({ query: recallQuery }));
  const recall = await resolveRecall(c.env, {
    query: expanded.query,
    focus,
    mode: memoryEngine,
    channel,
    requestId,
    skipMemorySource: shouldSkipMemoryRecall(pack),
    // 已经注入的记忆：召回只在「提示词里没有」的候选上跑（2026-11-08）
    injectedText: clipCore(pack.promptMemory.text),
    nowMs: now.getTime(),
    waitUntil: (p) => c.executionCtx.waitUntil(p),
  });
  c.executionCtx.waitUntil(recordCpuSample(c.env, channel, 'cpu_total', performance.now() - packT0).catch(() => {}));
  c.executionCtx.waitUntil(recordCpuSample(c.env, channel, 'recall_ms', performance.now() - recallT0).catch(() => {}));
  const recalledRaw = recall.text;

  // 探针/回归（record=false）不该产生"待确认"状态：跑一次 10 题就是 10 次 KV 写
  if (!noRecord) {
    void recordRecallUsage(c.env, recall.ids, now.getTime()).catch(() => {});
    void rememberPendingRecall(c.env, recall.ids, now.getTime()).catch(() => {});
  }
  const { recalled, budget: contextBudget } = budgetFromPack(
    pack,
    recalledRaw,
    historyRaw.map((m) => m.content),
  );
  logTrace('openai.context', {
    requestId,
    channel,
    memoryMode: promptMemory.mode,
    promptBytes: byteLength(promptMemory.text),
    historyRounds: groupTurns(historyRaw).length,
    memoryEngine,
    affectEngine,
    recalledItems: recalled.split('\n').filter((line) => line.startsWith('- ')).length,
    hasMemo: Boolean(recentMemo),
    hasSummary: Boolean(todaySummary),
    budgetChars: contextBudget.totalChars,
    budget: formatBudgetManifest(contextBudget.manifest),
    stream: body?.stream === true,
  });
  const astrbotSystems = textMessages.filter((m) => m.role === 'system').map((m) => m.content);
  // 最近几条回复的开头 / 口癖 / 括号动作：避免连续几轮用同一种写法
  const recentAssistantTexts = [
    ...historyRaw.filter((m) => m.role === 'assistant').map((m) => m.content),
    ...textMessages.filter((m) => m.role === 'assistant').map((m) => contentToText(m.content)),
  ];
  const avoidOpeners = recentOpeners(recentAssistantTexts);
  const avoidPhrases = recentPhrases(recentAssistantTexts);
  // 括号动作连用（围巾那条连续 6 次）是「看起来不专心」的主要来源（2026-11-09）
  const recentActs = recentActions(recentAssistantTexts);
  // 观测：相邻回复的 3-gram 相似度（自我重复率），只记录不干预
  void recordCpuSample(c.env, channel, 'self_repeat_x100', selfRepeatScore(recentAssistantTexts) * 100).catch(function () { return undefined; });
  const personaDrift = buildPersonaDriftLine(personaState);
  const lifeBlocks = await loadLifeBlocks(c.env, now, lastUserCleaned, historyRaw.slice(-6));
  const personaDoc = await loadPersonaDoc(c.env);
  // KV 等待不算 CPU：先把需要 await 的块准备好，再开始打点
  // 快照里带了话题块就直接用，避免再一次 D1 往返
  const topicsBlock = pack.topics || (await recentTopicsBlock(c.env, now).catch(() => ''));
  const cpuT0 = performance.now();
  // ★ 稳定段（人设 + 长期记忆 + 口吻）单独一条 system，每轮字节一致才吃得到前缀缓存。
  //   以前把易变段（话题 / 中期记忆 / 文件 / 状态卡 / 此刻）也拼进这一条，
  //   等于每轮都让整个前缀失效——按未命中价计费，也更容易被后面的内容抢走注意力。
  const promptSplit = buildSystemPromptSplit({
      now,
      personaDoc,
      userText: lastUserCleaned,
      ctx,
      memory: contextBudget.core,
      memoryMode: promptMemory.mode,
      weather,
      todaySummary: contextBudget.recent,
      recentMemo: contextBudget.recentMemo,
      recentTopics: topicsBlock,
      recalled: '',
      personaDrift,
      recentFiles,
      voiceReply,
      channel,
      characterCard: cardTextWithMood,
      voice: buildVoiceDirective(relation.intimacy, voiceModeOf(c.env)),
      avoidOpeners,
      avoidPhrases,
      attitude,
      characterName: c.env.CHARACTER_NAME,
      userAddress: c.env.USER_ADDRESS,
      residents: lifeBlocks.residents,
      location: lifeBlocks.location,
      persona: resolvePersona(c.env),
  });
  // AstrBot 自带的人格/系统消息属于「别人的稳定前缀」：排在第一位，位置也别动
  const stableSystem = [...astrbotSystems, promptSplit.stable].join('\n') + silentEndRule(channel);
  // 免费版 10ms CPU 预算：这里量的是纯 JS 拼装（D1/KV 等待不算 CPU）
  c.executionCtx.waitUntil(recordCpuSample(c.env, channel, 'cpu_prompt', performance.now() - cpuT0).catch(() => {}));

  // 她此刻在干什么 / 今天跟谁混：每轮都变，必须贴在历史之后（放前面会打断前缀缓存）
  const recentAssistant = historyRaw.filter((m) => m.role === 'assistant').map((m) => m.content);
  const tic = ticWarning(recentAssistant, resolvePersona(c.env).selfCall);
  const lifeBlock = [lifeBlocks.life, tic].filter(Boolean).join('\n\n') || null;

  // 易变段统一贴在历史之后、用户消息之前：每轮都在变，放进前缀会让缓存全部失效
  const volatileSystem = [promptSplit.volatile, historyNote, lifeBlock].filter(Boolean).join('\n');

  const upstream: DeepSeekMessage[] = [
    { role: 'system', content: stableSystem },
    ...historyMessages,
    ...textMessages.filter((m) => m.role !== 'system'),
    ...(volatileSystem ? [{ role: 'system' as const, content: volatileSystem }] : []),
  ];

  // 每轮把语气提醒贴到用户消息最前面；实时类问题再叠加准确事实（只改发给模型的内容，不写 D1）
  if (lastUser) {
    const parts: string[] = [];
    // ★ 格式要求放在这里：这是模型看到的最后一段指令（紧跟用户这句话），
    //   比系统提示词里靠前的位置有效得多。网页端不需要 QQ 表情/语音标记。
    if (channel === 'astrobot' || channel === 'mobile') {
      parts.push(
        '【可用】[face:表情名] → 表情；想发语音可以写成 [语音]「要说的话」（只念引号里）。用不用随你。',
      );
    }
    // ★ 召回结果贴到用户消息最前面（注意力最强的位置）：
    //   放在系统提示词中部时，隔着几千字，模型经常"看见了但没用"（2026-11-08）
    // 记忆题：先直答、别反问——否则同一题三发里两次"你说哪个"，像记不住
    if (isMemoryQuestion(lastUserCleaned)) {
      parts.push(memoryAnswerHint(
      // 覆盖率短路之后 recall 经常是空的，但长期记忆整段在提示词里——
      // 用「召回」判断会误伤成「记忆里没有」，于是她每句都先认怂（2026-11-08 实测）
      Boolean(contextBudget.recall.trim() || contextBudget.core.trim()),
    ));
    }
    // 未完成的约定每轮都带上：它不靠关键词命中，忘了就是忘了
    const promiseText = promisesBlock(pack.memory ?? '').trim();
    if (promiseText) parts.push(promiseText);
    // 这一轮别再用这些括号动作：连着用同一个小动作，看起来像没在听（2026-11-09）
    if (recentActs.length > 0) {
      parts.push('这一轮换个动作，或者干脆不写动作——连着几条都是同一个动作，像剧本。');
    }
    // 他当场嫌她管太宽：只影响这一轮（memory.md 要到明天 04:00 才更新）
    const naggingNote = naggingComplaintNote(lastUserCleaned);
    if (naggingNote) parts.push(naggingNote);
    if (contextBudget.recall.trim()) {
      parts.push(
        '你记得这些（他以前说过的、一起经历过的，可能和这轮有关）：\n' +
          contextBudget.recall.trim() +
          '\n（自然地用，不要逐条念出来；这轮用不上也不用硬提）',
      );
    }
    if (isNowFactQuestion(lastUserCleaned)) {
      parts.push(
        `【系统实时事实（最高优先级，不要复述这段格式）】${buildLiveFacts(now, ctx, weather)}。回答时间/天气/节假日时只以此为准，不要用历史或记忆里的旧值。`,
      );
    }
    const prefix = `${parts.join('\n\n')}\n\n`;
    lastUser.content =
      typeof lastUser.content === 'string'
        ? prefix + lastUser.content
        : [{ type: 'text' as const, text: prefix }, ...lastUser.content];
  }

  // 3) 图片：普通图片先压缩存 R2；带 #__transient 的（视频帧/拼图）只给模型看，不落 R2。
  //    带 #__store_only 的（GIF 原图）存 R2 后从模型请求里移除。
  const imageKeys: string[] = [];
  const audioKeys: string[] = [];
  let transientImages = 0;
  if (!skipRecording && Array.isArray(body?.image_keys)) {
    for (const raw of body.image_keys) {
      if (typeof raw === 'string' && raw.startsWith('images/') && raw.length <= 200) {
        imageKeys.push(raw);
      }
    }
  }
  if (!skipRecording && Array.isArray(body?.audio_keys)) {
    for (const raw of body.audio_keys) {
      if (typeof raw === 'string' && raw.startsWith('audio/') && raw.length <= 200) {
        audioKeys.push(raw);
      }
    }
  }
  if (!skipRecording && lastUser && Array.isArray(lastUser.content)) {
    for (const part of lastUser.content) {
      if (part.type !== 'image_url') continue;
      const rawUrl = part.image_url.url;
      if (rawUrl.startsWith('r2://')) {
        // 客户端已直传原图：只记 R2 key，不再二次下载/压缩/上传。
        const key = rawUrl.slice('r2://'.length);
        if (key.startsWith('images/')) imageKeys.push(key);
        part.image_url.url = '';
        continue;
      }
      if (rawUrl.endsWith('#__store_only')) {
        const saved = await saveImageFromSource(
          c.env,
          rawUrl.slice(0, -'#__store_only'.length),
          dateKey,
          now,
        );
        if (saved) imageKeys.push(saved.key);
        part.image_url.url = '';
        continue;
      }
      if (rawUrl.endsWith('#__transient')) {
        part.image_url.url = rawUrl.slice(0, -'#__transient'.length);
        transientImages += 1;
        continue;
      }
      const saved = await saveImageFromSource(c.env, rawUrl, dateKey, now);
      if (!saved) continue;
      const loaded = await loadImageDataUrl(c.env, saved.key);
      if (loaded) part.image_url.url = loaded.dataUrl; // DeepSeek 收到的是 R2 中的压缩图
      imageKeys.push(saved.key);
    }

    // 文本里带的媒体标记（App 发 GIF、网页发图只带路径）：读出来给模型看，
    // 否则模型只看到 "[GIF:gifs/...]" 这种字符串，等于没收到图。
    if (lastUser) {
      const flatText =
        typeof lastUser.content === 'string'
          ? lastUser.content
          : lastUser.content
              .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
              .map((p) => p.text)
              .join('\n');
      const markerKeys = [...flatText.matchAll(/\[(?:GIF|图片):((?:gifs|images|diary-images)\/[^\]\s]+)\]/g)]
        .map((m) => m[1])
        .slice(0, 4);
      const extraImages: Array<{ type: 'image_url'; image_url: { url: string } }> = [];
      for (const key of markerKeys) {
        const loaded = await loadImageDataUrl(c.env, key).catch(() => null);
        // 太大的对象（动辄几 MB 的 GIF）模型会直接忽略，白传一趟：
        // 只送 1.2MB 以内的；大动图由 App 附一张首帧静图，这里就跳过。
        if (loaded && loaded.dataUrl.length <= 1_600_000) {
          extraImages.push({ type: 'image_url', image_url: { url: loaded.dataUrl } });
        }
      }
      if (extraImages.length > 0) {
        const base =
          typeof lastUser.content === 'string'
            ? [{ type: 'text' as const, text: lastUser.content }]
            : lastUser.content;
        lastUser.content = [...base, ...extraImages];
        transientImages += extraImages.length;
      }
    }

    // 移除只存档的图片，避免把空 URL 发给模型
    const kept = lastUser.content.filter(
      (p) => !(p.type === 'image_url' && !p.image_url.url),
    );
    if (kept.length === 0) {
      lastUser.content = '';
    } else if (kept.length === 1 && kept[0].type === 'text') {
      lastUser.content = kept[0].text;
    } else {
      lastUser.content = kept;
    }
  }
  // 文本里已经带了 [GIF:…]/[视频:…] 就不再加 [视频帧]：
  // 那是 App 附给模型的静帧，气泡里已经有动图了，再挂个标记只会多一行噪音。
  const hasMediaMarker = /\[(?:GIF|视频|图片):/.test(lastUserCleaned);
  // 静帧的说明只进这一轮的提示词，不进记录：气泡里冒出「帧」「截图」这种词很出戏，
  // 她会照着念。历史消息里露出来的那几行就是这么来的。
  if (lastUser && transientImages > 0 && !hasMediaMarker) {
    // 说「第一张」等于把连续画面说成几张照片——线上真这么说过。
    // 明确两件事：这是同一段视频、按时间先后排；用「一开始/中间/最后」，不说「第几张」。
    const hint =
      '（这是一段视频，你按时间先后看过了其中若干画面，不是几张独立的照片；' +
      '描述时用「一开始」「中间」「后面」这种说法，不要说「第一张」「第几张」「帧」「截图」）';
    lastUser.content =
      typeof lastUser.content === 'string'
        ? lastUser.content
          ? `${lastUser.content}\n\n${hint}`
          : hint
        : [...lastUser.content, { type: 'text' as const, text: hint }];
  }
  const recordContent = [
    lastUserCleaned,
    ...(imageKeys.length > 0
      ? imageKeys.map((k) => `[图片:${k}]`)
      : transientImages > 0
        ? [] // 静帧不留标记：提示词里有，记录里没有
        : lastUserHasImage
          ? ['[图片]']
          : []),
    ...(audioKeys.length > 0 ? audioKeys.map((k) => `[语音:${k}]`) : []),
  ]
    .filter(Boolean)
    .join('\n');

  // 网页端发 B 站链接只会发裸 URL（App 是自己拼好 meta 的），
  // 这里补齐一份，卡片和模型看到的资料就一致了。已经有 meta 就不重复拉。
  let contentToStore = recordContent;
  if (
    !skipRecording &&
    contentToStore &&
    !contentToStore.includes('[BILI_META]') &&
    /bilibili\.com\/video\//i.test(contentToStore)
  ) {
    const biliUrl = findBiliUrl(contentToStore);
    if (biliUrl) {
      const meta = await fetchBiliMeta(biliUrl).catch(() => null);
      if (meta && meta.title) {
        const block = formatBiliMeta(meta, biliUrl);
        contentToStore = `${contentToStore}\n\n${block}`;
        // 模型也要看到标题/简介，不然它只知道有个链接
        if (lastUser) {
          if (typeof lastUser.content === 'string') {
            lastUser.content = `${lastUser.content}\n\n${block}`;
          } else {
            lastUser.content = [...lastUser.content, { type: 'text' as const, text: `\n${block}` }];
          }
        }
      }
    }
  }

  // ★ 纯图片消息（没有文字）早期不落库：earlyContent 为空，userMessageId 也没有，
  //   于是图片处理完拿到 [图片:key] 之后必须补落一次，否则这条消息在服务端根本不存在，
  //   客户端会永远卡在「发送中」（2026-11-07）。
  if (!skipRecording && !userMessageId && contentToStore) {
    const latest = await latestMessage(c.env);
    if (latest && latest.role === 'user' && latest.content === contentToStore) {
      userMessageId = latest.id;
    } else {
      const saved = await insertUserMessage(c.env, contentToStore, nowForStore, {
        channel,
        clientMessageId: clientMessageId || undefined,
      });
      userMessageId = saved.id;
      storedEarly = true;
      await markProfileDirty(c.env).catch(() => {});
    }
  }

  // 落库内容可能比"先落库"时多一点（图片标记、B 站资料）：以最终内容为准补一次
  if (storedEarly && userMessageId && contentToStore && contentToStore !== earlyContent) {
    await updateMessageContent(c.env, userMessageId, contentToStore).catch(() => {});
  }

  const onFinish = async (text: string, usage: TokenUsage | null) => {
    let cost = 0;
    const silent = isSilentEnd(text) && (channel === 'mobile' || channel === 'web');
    const stored = silent ? '' : normalizeAssistantText(text);
    if (!skipRecording && stored && userMessageId) {
      // 费用与 token 随 INSERT 一次写入（少一条 UPDATE）
      const saved = await insertAssistantReply(c.env, stored, userMessageId, now, {
        channel,
        cost: usage ? calcCost(usage, loadPricing(c.env), now) : 0,
        promptTokens: usage
          ? (usage.prompt_cache_hit_tokens ?? 0) + (usage.prompt_cache_miss_tokens ?? 0)
          : 0,
        completionTokens: usage?.completion_tokens ?? 0,
      });
      cost = saved.cost_rmb;
      if (cmidKey) {
        await putCachedTurn(c.env, cmidKey, {
          content: stored,
          user_message_id: userMessageId,
          assistant_message_id: saved.id,
        });
      }
    } else if (silent && !skipRecording && userMessageId && cmidKey) {
      // 静默也是一种合法结果：缓存 [END]，重试时不再调用模型。
      await putCachedTurn(c.env, cmidKey, { content: '[END]', user_message_id: userMessageId });
    }
    return cost;
  };

  // 回复长度交给模型自己决定：完美复刻语气优先，不再按对方字数硬压
  const requested =
    typeof body?.max_tokens === 'number' && body.max_tokens > 0 ? Math.floor(body.max_tokens) : null;
  // 8192 = DeepSeek 的输出上限，等于「不限制长度」
  // 默认 2048 约 1300 汉字：正常聊天够用，生成时间可控（手机端 120s 读超时的主要风险源）。
    // 要写长文时由客户端在 body.max_tokens 里显式要更多。
    const maxTokens = requested ?? 2048;

  // 输入指纹：事后能从 D1 认出"哪两轮的 prompt 撞了"（2026-11-10 逐字复读排查）
  try {
    const fp = promptFingerprint(upstream);
    c.executionCtx.waitUntil(
      recordRequest(c.env, {
        requestId,
        kind: 'chat',
        path: '/v1/chat#prompt',
        ms: 0,
        channel,
        ok: true,
        detail: JSON.stringify({
          promptHash: fp.hash,
          promptChars: fp.chars,
          historyRounds: groupTurns(historyRaw).length,
          tailIds: historyRaw.slice(-4).map((m) => m.id),
          // 最后三条的角色：正常应该是 "u"（以用户消息结尾）。
          // 出现 "a"/"s" 结尾就说明这轮用户的话没进提示词——那正是"复读上一句"的成因。
          tailRoles: upstream.slice(-3).map((m) => (m.role || '?').slice(0, 1)).join(''),
          userLen: lastUserCleaned.length,
        }),
      }).catch(() => {}),
    );
  } catch { /* 埋点失败不影响回复 */ }

  // 4) 流式 / 非流式
  if (body?.stream !== false) {
    return streamDeepSeek(c.env, upstream, { appendUsageEvent: false, maxTokens, onFinish });
  }

  c.executionCtx.waitUntil(recordCpuSample(c.env, channel, 'prep', performance.now() - prepT0).catch(() => {}));
  const result = await completeDeepSeek(c.env, upstream, now, maxTokens);
  if ('error' in result) return openaiError(c, result.status, result.error);
  const silent =
    isSilentEnd(result.text) && (channel === 'mobile' || channel === 'web');
  let stored = silent ? '' : normalizeAssistantText(result.text);
  // ★ 表情节流：上一条她已经发过表情，这一条就不再发（模型会每条都带，2026-11-06）
  const prevAssistant = historyRaw.filter((m) => m.role === 'assistant').slice(-1);
  const emojiThrottle = prevAssistant.some((m) => hasEmoji(m.content));
  if (emojiThrottle && stored) stored = stripEmoji(stored);
  if (silent) {
    if (!skipRecording && userMessageId && cmidKey) {
      await putCachedTurn(c.env, cmidKey, { content: '[END]', user_message_id: userMessageId });
    }
    return c.json({
      id: result.id,
      object: 'chat.completion',
      created: result.created,
      model: c.env.DEEPSEEK_MODEL,
      no_reply: true,
      choices: [
        { index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' },
      ],
      usage: result.usage,
    });
  }
  if (!skipRecording && stored && userMessageId) {
    const saved = await insertAssistantReply(c.env, stored, userMessageId, now, {
      channel,
      cost: result.cost,
      promptTokens: (result.usage?.prompt_cache_hit_tokens ?? 0) + (result.usage?.prompt_cache_miss_tokens ?? 0),
      completionTokens: result.usage?.completion_tokens ?? 0,
    });
    if (cmidKey) {
        await putCachedTurn(c.env, cmidKey, {
          content: stored,
          user_message_id: userMessageId,
          assistant_message_id: saved.id,
        });
    }
  }
  // 非流式回复也已经过 completeDeepSeek 的 AI 味清洗；
  // 手机/网页端直接给 emoji（客户端没有 QQ 表情表）；QQ 端保留 [face:名] 交给 AstrBot 转
  const clientTextRaw = channel === 'astrobot' ? result.text : replaceFaceMarkers(result.text);
  const clientText = emojiThrottle ? stripEmoji(clientTextRaw) : clientTextRaw;
  const promptTokens = (result.usage?.prompt_cache_hit_tokens ?? 0) + (result.usage?.prompt_cache_miss_tokens ?? 0);
  return c.json({
    id: result.id,
    object: 'chat.completion',
    created: result.created,
    model: c.env.DEEPSEEK_MODEL,
    choices: [
      { index: 0, message: { role: 'assistant', content: clientText }, finish_reason: result.finishReason },
    ],
    usage: result.usage
      ? {
          prompt_tokens: promptTokens,
          completion_tokens: result.usage.completion_tokens,
          total_tokens: promptTokens + result.usage.completion_tokens,
        }
      : null,
    // ★ 把这次实际落库的图片 key 回传：客户端收到后能把刚发的本地图按 key 存起来，
    //   之后刷新成正式气泡时直接命中本地缓存，不用再从服务器下一遍（2026-11-07）
    user_image_keys: imageKeys.length > 0 ? imageKeys : undefined,
  });
});
/** 同一条链接/视频他又发了一次？返回一句提醒，让她顺着上次说。 */
function repeatedContentNote(history: MessageRow[], current: string, now: Date): string | null {
  const idOf = (text: string): string | null => {
    const m = text.match(/b23\.tv\/([A-Za-z0-9]+)/) ?? text.match(/(BV[0-9A-Za-z]{10})/);
    return m ? (m[1] ?? m[0]) : null;
  };
  const cur = idOf(current);
  if (!cur) return null;
  let at = -1;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i].role === 'user' && history[i].content.includes(cur)) { at = i; break; }
  }
  if (at < 0) return null;
  const prev = history[at];
  const reply = history.slice(at + 1).find((m) => m.role === 'assistant');
  const mins = Math.max(1, Math.round((now.getTime() - new Date(prev.created_at).getTime()) / 60_000));
  const said = reply ? `，你当时回的是「${compactHistoryMessage(reply.content, 40)}」` : '';
  return `（这条内容他 ${mins} 分钟前发过一次${said}；这次顺着上次往下说，别当成新的再演一遍）`;
}
