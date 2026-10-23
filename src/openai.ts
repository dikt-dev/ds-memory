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
import { insertUserMessage, insertAssistantReply, latestMessage } from './db';
import { calcCost, loadPricing, type TokenUsage } from './pricing';
import { completeDeepSeek, streamDeepSeek, type DeepSeekMessage } from './deepseek';
import { getTodaySummary, maybeSummarizeToday } from './summary';
import { describeAttitude } from './attitude';
import { loadImageDataUrl, saveImageFromSource } from './media';
import { parseRelationValues } from './memory-maintenance';
import { markProfileDirty } from './profile-cache';
import { computeMoodDrift } from './mood-env';
import { buildCharacterCard } from './character-card';
import { readSessionFacts } from './session-facts';
import { buildVoiceDirective } from './voice';
import { getSessionMood, inferTag, sessionMoodNote, updateSessionMood } from './session-state';
import { formatRecentMemoBlock, getRecentMemo, maybeRefreshRecentMemo } from './recent-memory';
import { recallForQuery } from './memory-archive';

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
  const skipRecording = (!lastUserCleaned && !lastUserHasImage) || isProactiveRequest(lastUserCleaned);

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
  // 中期记忆存在时跳过今日摘要，避免重复注入同一段时间的事
  const todaySummary = recentMemo ? null : await getTodaySummary(c.env, dateKey);
  const relation = parseRelationValues(memory);
  // 实时叠加环境心情漂移（只影响本次语气，不写回）
  const envHour = beijingHour(now);
  const envMonth = beijingMonth(now);
  const drift = computeMoodDrift({ hour: envHour, isRestDay: dayCtx.is_holiday, weather, month: envMonth });
  const sessionMood = await getSessionMood(c.env, now.getTime());
  const effectiveMood = Math.min(1000, Math.max(0, relation.mood + drift.delta + sessionMood.offset));
  // AstrBot 侧默认渠道为 AstrBot；未来其它客户端调用 /v1 可用 X-Client-Channel 声明
  const channel = normalizeChannel(c.req.header('x-client-channel'), 'astrobot');
  // ★ 活人感：状态卡 + 口语化（AstrBot 落库在 send 之前，故此处查询的是落库前的状态）
  const facts = await readSessionFacts(c.env, now, dateKey);
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
  const moodNote = sessionMoodNote(sessionMood);
  const cardTextWithMood = moodNote ? `${charCard.cardText}\n- 情绪残留：${moodNote}` : charCard.cardText;
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
      channel,
      characterCard: cardTextWithMood,
      voice: buildVoiceDirective(relation.intimacy),
      attitude: describeAttitude(relation.affinity, relation.intimacy, effectiveMood),
      characterName: c.env.CHARACTER_NAME,
      userAddress: c.env.USER_ADDRESS,
    }),
  ].join('\n\n');
  const upstream: DeepSeekMessage[] = [
    { role: 'system', content: mergedSystem },
    ...textMessages.filter((m) => m.role !== 'system'),
  ];

  // 3) 图片：AstrBot 传来的图片先压缩存 R2，再把 R2 里的图片发给 DeepSeek；D1 记录 R2 路径。
  const imageKeys: string[] = [];
  if (!skipRecording && lastUser && Array.isArray(lastUser.content)) {
    for (const part of lastUser.content) {
      if (part.type !== 'image_url') continue;
      const saved = await saveImageFromSource(c.env, part.image_url.url, dateKey, now);
      if (!saved) continue;
      const loaded = await loadImageDataUrl(c.env, saved.key);
      if (loaded) part.image_url.url = loaded.dataUrl; // DeepSeek 收到的是 R2 中的压缩图
      imageKeys.push(saved.key);
    }
  }
  const recordContent = [
    lastUserCleaned,
    ...(imageKeys.length > 0
      ? imageKeys.map((k) => `[图片:${k}]`)
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

  /**
   * 会话情绪残留：用本轮用户消息 + 回复推断情绪，写进 KV（下一轮生效）。
   * 流式与非流式都调它——之前只有流式会写，非流式（部分客户端）情绪永远不更新。
   */
  const recordSessionMood = async (replyText: string) => {
    if (skipRecording) return;
    try {
      const tag = inferTag(lastUserCleaned, replyText);
      await updateSessionMood(c.env, now.getTime(), tag);
    } catch {
      /* 忽略 */
    }
  };

  const onFinish = async (text: string, usage: TokenUsage | null) => {
    let cost = 0;
    if (!skipRecording && text.trim() && userMessageId) {
      // 费用与 token 随 INSERT 一次写入（少一条 UPDATE）
      const saved = await insertAssistantReply(c.env, text, userMessageId, now, {
        channel,
        cost: usage ? calcCost(usage, loadPricing(c.env), now) : 0,
        promptTokens: usage
          ? (usage.prompt_cache_hit_tokens ?? 0) + (usage.prompt_cache_miss_tokens ?? 0)
          : 0,
        completionTokens: usage?.completion_tokens ?? 0,
      });
      cost = saved.cost_rmb;
    }
    // ★ 会话情绪残留：用本轮用户消息推断情绪并写入 KV（下一轮生效）
    await recordSessionMood(text);
    return cost;
  };

  // 4) 流式 / 非流式
  if (body?.stream !== false) {
    return streamDeepSeek(c.env, upstream, { appendUsageEvent: false, onFinish });
  }

  const maxTokens = typeof body?.max_tokens === 'number' && body.max_tokens > 0 ? Math.floor(body.max_tokens) : 4096;
  const result = await completeDeepSeek(c.env, upstream, now, maxTokens);
  if ('error' in result) return openaiError(c, result.status, result.error);
  if (!skipRecording && result.text.trim() && userMessageId) {
    await insertAssistantReply(c.env, result.text, userMessageId, now, {
      channel,
      cost: result.cost,
      promptTokens: (result.usage?.prompt_cache_hit_tokens ?? 0) + (result.usage?.prompt_cache_miss_tokens ?? 0),
      completionTokens: result.usage?.completion_tokens ?? 0,
    });
  }
  // ★ 非流式也要更新会话情绪残留（与流式保持一致）
  await recordSessionMood(result.text);
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
