/**
 * 聊天链路（网页端）：组装上下文 → DeepSeek 流式请求 → SSE 透传给前端。
 * 落库顺序：先读历史（不含本条）→ 落 user 消息 → 流结束后落 assistant 回复并计费。
 * 图片：已压缩存入 R2（images/日期/时间戳.jpg），发给 DeepSeek 时从 R2 读回；D1 只记录 R2 路径。
 */
import type { Env } from './types';
import { buildSystemPrompt, type MessageChannel } from './prompt';
import { beijingHour, beijingMonth, dateKeyInBeijing } from './date';
import { attachWeather, getOrCreateDayContext } from './context';
import { getMemory } from './memory';
import { fetchWeather } from './weather';
import { insertUserMessage, insertAssistantReply, recentMessages } from './db';
import { calcCost, loadPricing } from './pricing';
import { streamDeepSeek, type DeepSeekMessage } from './deepseek';
import { getTodaySummary } from './summary';
import { describeAttitude } from './attitude';
import { loadImageDataUrl } from './media';
import { parseRelationValues } from './memory-maintenance';
import { markProfileDirty } from './profile-cache';
import { computeMoodDrift } from './mood-env';
import { buildCharacterCard } from './character-card';
import { readSessionFacts } from './session-facts';
import { buildVoiceDirective } from './voice';
import { getSessionMood, inferTag, sessionMoodNote, updateSessionMood } from './session-state';
import { formatRecentMemoBlock, getRecentMemo } from './recent-memory';
import { recallForQuery } from './memory-archive';

export interface ChatImage {
  key: string; // R2 对象键（images/日期/时间戳.jpg）
}

export async function streamChat(
  env: Env,
  content: string,
  now: Date,
  image?: ChatImage,
  channel: MessageChannel = 'web',
): Promise<Response> {
  const apiKey = env.DEEPSEEK_API_KEY;
  if (!apiKey) return Response.json({ error: 'DEEPSEEK_API_KEY 未配置' }, { status: 500 });

  // 1) 组装上下文（先取历史，再落 user 消息，避免历史里重复出现本条）
  const dateKey = dateKeyInBeijing(now);
  const memory = await getMemory(env);
  const dayCtxFile = await getOrCreateDayContext(env, dateKey);
  const weather = await fetchWeather(env);
  // 传入刚读到的 dayCtxFile：attachWeather 可省掉一次 R2 读，且天气没变就不写
  if (weather) await attachWeather(env, dateKey, weather, dayCtxFile);
  const ctx = {
    date: dayCtxFile.date,
    weekday: dayCtxFile.weekday,
    is_holiday: dayCtxFile.is_holiday,
    holiday_note: dayCtxFile.holiday_note,
  };
  const history = await recentMessages(env, 20);
  // ★ 中期记忆（最近 24 小时）优先：它存在时就不再注入今日摘要，避免同一段内容发两遍
  const recentMemo = formatRecentMemoBlock(await getRecentMemo(env));
  const todaySummary = recentMemo ? null : await getTodaySummary(env, dateKey);

  // ★ 按需检索：用当前消息 + 最近几条用户消息去档案里找相关往事（不命中就不占字节）
  const recallQuery = [
    content,
    ...history
      .filter((m) => m.role === 'user')
      .slice(-3)
      .map((m) => m.content),
  ].join(' ');
  const recalled = await recallForQuery(env, recallQuery);

  // ★ 活人感：在落库本条前采集「距上次聊天间隔 + 今日轮数」
  const relationVals = parseRelationValues(memory);
  const facts = await readSessionFacts(env, now, dateKey);
  const hourForCard = beijingHour(now);
  const envDriftForMood = computeMoodDrift({
    hour: hourForCard,
    isRestDay: dayCtxFile.is_holiday,
    weather,
    month: beijingMonth(now),
  });
  // ★ 会话级情绪残留（最近几轮的轻快/低落还会"漏"到这一轮）
  const sessionMood = await getSessionMood(env, now.getTime());
  const effectiveMood = Math.min(1000, Math.max(0, relationVals.mood + envDriftForMood.delta + sessionMood.offset));
  const moodNote = sessionMoodNote(sessionMood);
  const charCard = buildCharacterCard({
    hour: hourForCard,
    hoursSinceLastContact: facts.hoursSinceLastContact,
    mood: effectiveMood,
    affinity: relationVals.affinity,
    intimacy: relationVals.intimacy,
    todayTurns: facts.todayTurns,
    dateKey,
    wasIgnored: facts.wasIgnored,
    ignoredMessage: facts.ignoredMessage,
  });
  // 情绪残留单独注一句（附在状态卡后面）
  const cardTextWithMood = moodNote ? `${charCard.cardText}\n- 情绪残留：${moodNote}` : charCard.cardText;

  // 2) 落用户消息（D1 只存文本，图片记 R2 路径）
  const recordContent = image ? [content, `[图片:${image.key}]`].filter(Boolean).join('\n') : content;
  const userRow = await insertUserMessage(env, recordContent, now, { channel });
  // 有新用户消息 → 用户画像需要重算（下次主动消息决策时生效）
  await markProfileDirty(env).catch(() => {});

  // 3) 发给 DeepSeek 的图片从 R2 读回（压缩后的版本）
  let userContent: DeepSeekMessage['content'] = content;
  if (image) {
    const loaded = await loadImageDataUrl(env, image.key);
    userContent = [
      { type: 'text', text: content || '请看看这张图片。' },
      ...(loaded ? [{ type: 'image_url' as const, image_url: { url: loaded.dataUrl } }] : []),
    ];
  }

  const messages: DeepSeekMessage[] = [
    {
      role: 'system',
      content: buildSystemPrompt({
        now,
        ctx,
        memory,
        weather,
        todaySummary,
        recentMemo,
        recalled,
        channel,
        characterCard: cardTextWithMood,
        voice: buildVoiceDirective(relationVals.intimacy),
        attitude: describeAttitude(relationVals.affinity, relationVals.intimacy, effectiveMood),
      }),
    },
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: userContent },
  ];

  // 4) 流式转发；流结束落库 + 计费
  return streamDeepSeek(env, messages, {
    appendUsageEvent: true,
    onFinish: async (text, usage) => {
      let cost = 0;
      let assistantId: number | undefined;
      if (text.trim()) {
        // 费用与 token 随 INSERT 一次写入（少一条 UPDATE）
        const saved = await insertAssistantReply(env, text, userRow.id, now, {
          channel,
          cost: usage ? calcCost(usage, loadPricing(env), now) : 0,
          promptTokens: usage
            ? (usage.prompt_cache_hit_tokens ?? 0) + (usage.prompt_cache_miss_tokens ?? 0)
            : 0,
          completionTokens: usage?.completion_tokens ?? 0,
        });
        cost = saved.cost_rmb;
        assistantId = saved.id;
      }
      // ★ 会话情绪残留：用本轮用户消息推断情绪并写入 KV（下一轮生效）
      try {
        const tag = inferTag(content, text);
        await updateSessionMood(env, now.getTime(), tag);
      } catch { /* 忽略 */ }
      // 把 id 一并返回：前端用它推进轮询游标，避免重复渲染同一轮
      return { cost, ids: { user: userRow.id, assistant: assistantId } };
    },
  });
}
