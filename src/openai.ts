/**
 * OpenAI 兼容端点（供 AstrBot 等第三方接入）。
 * 鉴权：Authorization: Bearer <ASTROBOT_API_KEY>（与网页口令分离，可随时吊销）。
 * 注入：长期记忆 + 日期/节假日/天气；保留调用方自带的人格/系统消息。
 * 落库：只记录增量（最后一条 user 消息 + 本次回复），保证每日归档/提炼覆盖 AstrBot 对话。
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Env } from './types';
import { buildBaseSystemPrompt, normalizeChannel } from './prompt';
import { beijingHour, beijingMonth, dateKeyInBeijing } from './date';
import { attachWeather, getOrCreateDayContext } from './context';
import { getMemory } from './memory';
import { fetchWeather } from './weather';
import { insertUserMessage, insertAssistantReply, latestMessage, recentMessages, compactHistoryMessage } from './db';
import { calcCost, loadPricing, type TokenUsage } from './pricing';
import { completeDeepSeek, streamDeepSeek, type DeepSeekMessage } from './deepseek';
import { getTodaySummary, maybeSummarizeToday } from './summary';
import { loadImageDataUrl, saveImageFromSource } from './media';
import { parseRelationValues } from './memory-maintenance';
import { markProfileDirty } from './profile-cache';
import { readSessionFacts } from './session-facts';
import { buildCharacterCard } from './character-card';
import { facetsOf, processEmotionTurn } from './emotion-context';
import { moodFromVector } from './emotion-vector';
import { buildVoiceDirective, recentOpeners, replyTokenBudget } from './voice';
import { formatRecentMemoBlock, getRecentMemo, maybeRefreshRecentMemo } from './recent-memory';
import { recallForQuery } from './memory-archive';
import { recordFiles, recentFilesBlock } from './recent-files';

type AppEnv = { Bindings: Env };
export const openaiApp = new Hono<AppEnv>();

function openaiError(c: Context<AppEnv>, status: number, message: string) {
  return c.json(
    {
      error: { message, type: status === 401 ? 'authentication_error' : 'invalid_request_error' },
    },
    status as ContentfulStatusCode,
  );
}

async function checkBearer(c: Context<AppEnv>): Promise<boolean> {
  const expected = c.env.ASTROBOT_API_KEY;
  if (!expected) return false;
  const auth = c.req.header('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  return token.length > 0 && token === expected;
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
  return text
    .replace(/^\s*\[(?:语音|voice)\]\s*/i, '（语音）')
    .replace(/\[face[:：][^\]]{1,12}\]/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
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
  const body = (await c.req.json().catch(() => null)) as {
    messages?: unknown;
    stream?: unknown;
    max_tokens?: unknown;
    tools?: unknown;
    inject_history?: unknown;
    files?: unknown;
    /** false = 这轮不要写进聊天记录（指令类消息） */
    record?: unknown;
  } | null;
  const rawMessages = body?.messages;
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
    return openaiError(c, 400, 'messages 不能为空');
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

  // 2) 注入长期记忆与当天上下文（保留 AstrBot 自带的人格/系统消息）
  const now = new Date();
  const dateKey = dateKeyInBeijing(now);
  c.executionCtx.waitUntil(maybeSummarizeToday(c.env, dateKey)); // 异步滚动摘要，不阻塞
  c.executionCtx.waitUntil(maybeRefreshRecentMemo(c.env, now)); // 异步刷新中期记忆（最近 24h）
  const memory = await getMemory(c.env);
  const dayCtx = await getOrCreateDayContext(c.env, dateKey);
  const weather = await fetchWeather(c.env);
  if (weather) await attachWeather(c.env, dateKey, weather, dayCtx);
  const ctx = {
    date: dayCtx.date,
    weekday: dayCtx.weekday,
    is_holiday: dayCtx.is_holiday,
    holiday_note: dayCtx.holiday_note,
  };
  const recentMemo = formatRecentMemoBlock(await getRecentMemo(c.env));
  // 文件沉淀：先记账再读，本轮发的文件立刻能出现在提示词里
  await recordFiles(c.env, body?.files);
  const recentFiles = await recentFilesBlock(c.env, now);
  // 中期记忆存在时跳过今日摘要，避免重复注入同一段时间的事
  const todaySummary = recentMemo ? null : await getTodaySummary(c.env, dateKey);
  const relation = parseRelationValues(memory);
  // ★ 先取会话事实：环境漂移要按「距上次多久」折算，不能每轮全额叠加
  const facts = await readSessionFacts(c.env, now, dateKey);
  const envHour = beijingHour(now);
  const envMonth = beijingMonth(now);
  // AstrBot 侧默认渠道为 AstrBot；未来其它客户端调用 /v1 可用 X-Client-Channel 声明
  const channel = normalizeChannel(c.req.header('x-client-channel'), 'astrobot');
  // 客户端声明了支持语音，才告诉模型可以发 [语音]（没装 TTS 的客户端不会收到这句提示）
  const voiceReply = c.req.header('x-client-voice') === '1';

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
  });
  // ★ 心情值不再单独维护：由情绪向量派生，保证只有一份真相
  const effectiveMood = moodFromVector(emotion.state.vector);
  // ★ 活人感：状态卡 + 口语化（AstrBot 落库在 send 之前，故此处查询的是落库前的状态）
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
  });
  const cardTextWithMood = charCard.cardText;
  // ★ 按需检索：用本轮用户消息 + 前面几条用户消息去档案里找相关往事
  const recallQuery = [
    lastUserCleaned,
    ...textMessages
      .filter((m) => m.role === 'user')
      .slice(-3, -1)
      .map((m) => contentToText(m.content)),
  ].join(' ');
  const recalled = await recallForQuery(c.env, recallQuery);
  const astrbotSystems = textMessages.filter((m) => m.role === 'system').map((m) => m.content);
  // 最近几条回复的开头：避免连续几轮用同一句开场白
  const avoidOpeners = recentOpeners(
    textMessages.filter((m) => m.role === 'assistant').map((m) => contentToText(m.content)),
  );
  const mergedSystem = [
    ...astrbotSystems,
    buildBaseSystemPrompt({
      now,
      ctx,
      memory,
      weather,
      todaySummary,
      recentMemo,
      recalled,
      recentFiles,
      voiceReply,
      channel,
      characterCard: cardTextWithMood,
      voice: buildVoiceDirective(relation.intimacy),
      avoidOpeners,
      attitude: emotion.snapshot,
      characterName: c.env.CHARACTER_NAME,
      userAddress: c.env.USER_ADDRESS,
    }),
  ].join('\n\n');
  // QQ 客户端只发当前一条；inject_history=true 时从 D1 补最近 8 条短期原文。
  // 当前消息尚未落库，所以不会重复；若历史末尾与当前文本相同，再主动去重一次。
  let historyMessages: DeepSeekMessage[] = [];
  if (body?.inject_history === true && !skipRecording) {
    const rows = await recentMessages(c.env, 8);
    historyMessages = rows
      .filter(
        (m, i) =>
          !(i === rows.length - 1 && m.role === 'user' && m.content === lastUserCleaned),
      )
      .filter((m) => m.content.trim())
      .map((m, i, arr) => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        // 最近 4 条保留原文，更早的压缩到 400 字内省 token
        // ★ 带文件的消息放宽到 3000 字：压缩到 400 字后「那个表第三行」就对不上了。
        content:
          i >= arr.length - 4
            ? m.content
            : m.content.includes('【文件：')
              ? compactHistoryMessage(m.content, 3000)
              : compactHistoryMessage(m.content),
      }));
  }
  const upstream: DeepSeekMessage[] = [
    { role: 'system', content: mergedSystem },
    ...historyMessages,
    ...textMessages.filter((m) => m.role !== 'system'),
  ];

  // 3) 图片：普通图片先压缩存 R2；带 #__transient 的（视频帧/拼图）只给模型看，不落 R2。
  //    带 #__store_only 的（GIF 原图）存 R2 后从模型请求里移除。
  const imageKeys: string[] = [];
  let transientImages = 0;
  if (!skipRecording && lastUser && Array.isArray(lastUser.content)) {
    for (const part of lastUser.content) {
      if (part.type !== 'image_url') continue;
      const rawUrl = part.image_url.url;
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
  const recordContent = [
    lastUserCleaned,
    ...(imageKeys.length > 0
      ? imageKeys.map((k) => `[图片:${k}]`)
      : transientImages > 0
        ? ['[视频帧]']
        : lastUserHasImage
          ? ['[图片]']
          : []),
  ]
    .filter(Boolean)
    .join('\n');

  let userMessageId: number | undefined;
  if (!skipRecording && recordContent) {
    const latest = await latestMessage(c.env);
    if (latest && latest.role === 'user' && latest.content === recordContent) {
      userMessageId = latest.id; // 重试请求：复用已存在的这一轮
    } else {
      const saved = await insertUserMessage(c.env, recordContent, now, { channel });
      userMessageId = saved.id;
      await markProfileDirty(c.env).catch(() => {});
    }
  }

  const onFinish = async (text: string, usage: TokenUsage | null) => {
    let cost = 0;
    const stored = normalizeAssistantText(text);
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
    }
    return cost;
  };

  // 4) 流式 / 非流式
  if (body?.stream !== false) {
    return streamDeepSeek(c.env, upstream, { appendUsageEvent: false, onFinish });
  }

  // ★ 客户端只能压低、不能抬高预算：如果客户端写死 4096，会把「按长度自适应」盖掉
  const budget = replyTokenBudget(lastUserCleaned);
  const requested =
    typeof body?.max_tokens === 'number' && body.max_tokens > 0 ? Math.floor(body.max_tokens) : null;
  const maxTokens = requested ? Math.min(requested, budget) : budget;
  const result = await completeDeepSeek(c.env, upstream, now, maxTokens);
  if ('error' in result) return openaiError(c, result.status, result.error);
  if (!skipRecording && normalizeAssistantText(result.text) && userMessageId) {
    await insertAssistantReply(c.env, normalizeAssistantText(result.text), userMessageId, now, {
      channel,
      cost: result.cost,
      promptTokens: (result.usage?.prompt_cache_hit_tokens ?? 0) + (result.usage?.prompt_cache_miss_tokens ?? 0),
      completionTokens: result.usage?.completion_tokens ?? 0,
    });
  }
  // 非流式回复也已经过 completeDeepSeek 的 AI 味清洗
  const promptTokens = (result.usage?.prompt_cache_hit_tokens ?? 0) + (result.usage?.prompt_cache_miss_tokens ?? 0);
  return c.json({
    id: result.id,
    object: 'chat.completion',
    created: result.created,
    model: c.env.DEEPSEEK_MODEL,
    choices: [
      { index: 0, message: { role: 'assistant', content: result.text }, finish_reason: result.finishReason },
    ],
    usage: result.usage
      ? {
          prompt_tokens: promptTokens,
          completion_tokens: result.usage.completion_tokens,
          total_tokens: promptTokens + result.usage.completion_tokens,
        }
      : null,
  });
});
