/**
 * 聊天链路（网页端）：组装上下文 → DeepSeek 流式请求 → SSE 透传给前端。
 * 落库顺序：先读历史（不含本条）→ 落 user 消息 → 流结束后落 assistant 回复并计费。
 * 图片：已压缩存入 R2（images/日期/时间戳.jpg），发给 DeepSeek 时从 R2 读回；D1 只记录 R2 路径。
 */
import type { Env } from './types';
import { buildSystemPrompt, type MessageChannel, buildLiveFacts, isNowFactQuestion, STYLE_REMINDER } from './prompt';
import { buildPersonaDriftLine, loadPersonaState } from './persona-drift';
import { beijingHour, beijingMonth, dateKeyInBeijing } from './date';
import { attachWeather, getOrCreateDayContext } from './context';
import { getMemory } from './memory';
import { fetchWeather } from './weather';
import {
  insertUserMessage,
  insertAssistantReply,
  compactHistoryMessage,
  groupTurns,
  historyRangeNote,
  withHistoryTimestamp,
  HISTORY_FILE_MAX_CHARS,
  HISTORY_MESSAGE_MAX_CHARS,
} from './db';
import { loadRecentRounds, RECENT_ROUNDS } from './recent-context';
import { calcCost, loadPricing } from './pricing';
import { streamDeepSeek, type DeepSeekMessage } from './deepseek';
import { getTodaySummary } from './summary';
import { loadImageDataUrl } from './media';
import { byteLength, parseRelationValues } from './memory-maintenance';
import { markProfileDirty } from './profile-cache';
import { buildCharacterCard } from './character-card';
import { facetsOf, processEmotionTurn } from './emotion-context';
import { moodFromVector } from './emotion-vector';
import { readSessionFacts } from './session-facts';
import { buildVoiceDirective, recentOpeners } from './voice';
import { formatRecentMemoBlock, getRecentMemo } from './recent-memory';
import { embedTexts, extractPromptMemory, recallMemoryForChat, stripDuplicateRecall } from './memory-index';
import { loadMemoryChunks } from './memory-context-store';
import { formatMemoryChunks, rankMemoryChunks, shouldRecallMemory } from './memory-domain';
import { buildAttitudePolicy } from './attitude-policy';
import { packMemoryChunks } from './context-packer';
import { affectEngineFor, memoryEngineFor } from './engine-flags';
import { recordEngineMetric } from './engine-metrics';
import { logTrace } from './trace';

export interface ChatImage {
  key: string; // R2 对象键（images/日期/时间戳.jpg）
}

export async function streamChat(
  env: Env,
  content: string,
  now: Date,
  image?: ChatImage,
  channel: MessageChannel = 'web',
  requestId?: string,
): Promise<Response> {
  const apiKey = env.DEEPSEEK_API_KEY;
  if (!apiKey) return Response.json({ error: 'DEEPSEEK_API_KEY 未配置' }, { status: 500 });

  // 1) 组装上下文（先取历史，再落 user 消息，避免历史里重复出现本条）
  const dateKey = dateKeyInBeijing(now);
  // 这些读取互不依赖：并行发起，减少手机 QQ 场景的首字延迟。
  const [memory, dayCtxFile, fetchedWeather, history, recentMemoRaw, summaryRaw, personaState] =
    await Promise.all([
      getMemory(env),
      getOrCreateDayContext(env, dateKey),
      fetchWeather(env),
      loadRecentRounds(env, RECENT_ROUNDS, now),
      getRecentMemo(env),
      getTodaySummary(env, dateKey),
      loadPersonaState(env),
    ]);
  // 小记忆全量带上，大记忆只带核心+稳定画像，其余靠召回
  const promptMemory = extractPromptMemory(memory);
  // 拉取失败时回退到当天缓存，避免提示词里直接没有天气、让模型去翻旧记忆
  const weather = fetchedWeather ?? dayCtxFile.weather ?? null;
  if (fetchedWeather) await attachWeather(env, dateKey, fetchedWeather, dayCtxFile);
  const ctx = {
    date: dayCtxFile.date,
    weekday: dayCtxFile.weekday,
    is_holiday: dayCtxFile.is_holiday,
    holiday_note: dayCtxFile.holiday_note,
  };
  // 最近几条回复的开头：避免连续几轮用同一句开场白
  const avoidOpeners = recentOpeners(history.filter((m) => m.role === 'assistant').map((m) => m.content));
  // ★ 中期记忆（最近 24 小时）优先：它存在时就不再注入今日摘要，避免同一段内容发两遍
  const recentMemo = formatRecentMemoBlock(recentMemoRaw);
  const todaySummary = recentMemo ? null : summaryRaw;
  const personaDrift = buildPersonaDriftLine(personaState);

  // ★ 按需检索：用当前消息 + 最近几条用户消息去档案里找相关往事（不命中就不占字节）
  const recallQuery = [
    content,
    ...history
      .filter((m) => m.role === 'user')
      .slice(-3)
      .map((m) => m.content),
  ].join(' ');
  let recalledRaw = await recallMemoryForChat(
    env,
    recallQuery,
    undefined,
    history.slice(-8).map((m) => m.content).join(' '),
    // 全量记忆已经带上所有 memory 条目，召回只补档案层的旧事
    { skipMemorySource: promptMemory.mode === 'full' },
  );

  // Phase 2：Memory Context 影子/新引擎。默认 legacy，不改变线上回复。
  const memoryEngine = memoryEngineFor(env, channel);
  if (memoryEngine === 'shadow' || memoryEngine === 'next') {
    if (!shouldRecallMemory(recallQuery)) {
      logTrace('memory.engine.skip', {
        requestId: requestId ?? 'none',
        engine: memoryEngine,
        reason: 'low_signal_query',
      });
    } else {
    const oldBytes = byteLength(recalledRaw);
    const startedAt = performance.now();
    try {
      const chunks = await loadMemoryChunks(env);
      const focus = history.slice(-8).map((m) => m.content).join(' ');
      const keywordPicked = rankMemoryChunks(recallQuery, chunks, 6, focus);
      // 关键词已经够强时不再付 query embedding 延迟；弱召回才走向量。
      const hasVectors = chunks.some((chunk) => Boolean(chunk.vec));
      const queryVec =
        hasVectors && keywordPicked.length < 3
          ? ((await embedTexts(env, [recallQuery]))[0] ?? null)
          : null;
      const picked =
        queryVec !== null
          ? rankMemoryChunks(recallQuery, chunks, 6, focus, { queryVec })
          : keywordPicked;
      const packed = packMemoryChunks(picked);
      const nextRaw = formatMemoryChunks(packed.chunks);
      const shadowMs = Math.round(performance.now() - startedAt);
      const oldItems = recalledRaw.split('\n').filter((line) => line.startsWith('- ')).length;
      logTrace('memory.engine', {
        requestId: requestId ?? 'none',
        engine: memoryEngine,
        oldItems,
        nextItems: packed.chunks.length,
        oldBytes,
        nextBytes: byteLength(nextRaw),
        packedDropped: packed.dropped,
        hasVector: Boolean(queryVec),
        shadowMs,
      });
      await recordEngineMetric(env, {
        channel,
        kind: 'memory',
        mode: memoryEngine,
        oldItems,
        newItems: packed.chunks.length,
        oldBytes,
        newBytes: byteLength(nextRaw),
        ms: shadowMs,
        now: now.getTime(),
      });
      if (memoryEngine === 'next' && nextRaw) recalledRaw = nextRaw;
    } catch (e) {
      logTrace('memory.engine.error', {
        requestId: requestId ?? 'none',
        engine: memoryEngine,
        message: e instanceof Error ? e.message : String(e),
      });
    }
    }
  }

  const recalled = stripDuplicateRecall(
    recalledRaw,
    [...history.map((m) => m.content), recentMemo, promptMemory.text].filter(Boolean),
  );

  const affectEngine = affectEngineFor(env, channel);
  // Phase 0 trace：只记录元信息，不记录正文/记忆内容。
  logTrace('chat.context', {
    requestId: requestId ?? 'none',
    channel,
    memoryMode: promptMemory.mode,
    memoryEngine,
    affectEngine,
    promptBytes: byteLength(promptMemory.text),
    historyRounds: groupTurns(history).length,
    recalledItems: recalled.split('\n').filter((line) => line.startsWith('- ')).length,
    hasMemo: Boolean(recentMemo),
    hasSummary: Boolean(todaySummary),
  });

  // ★ 活人感：在落库本条前采集「距上次聊天间隔 + 今日轮数」
  const relationVals = parseRelationValues(memory);
  const facts = await readSessionFacts(env, now, dateKey);
  const hourForCard = beijingHour(now);

  // ★ 情感系统：事件 → 情绪向量 → 5 轴微增量 → 情绪快照（先算，后面的状态卡要用它派生心情）
  const emotion = await processEmotionTurn({
    env,
    now: now.getTime(),
    base: facetsOf(relationVals),
    userText: content,
    environment: {
      hour: hourForCard,
      isRestDay: dayCtxFile.is_holiday,
      weather,
      month: beijingMonth(now),
    },
    wasIgnored: facts.wasIgnored,
  });

  // Phase 3：态度策略影子/新引擎。默认 legacy，不改变回复。
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
      requestId: requestId ?? 'none',
      engine: affectEngine,
      archetype: policy.archetype,
      tone: policy.tone,
      directives: policy.directives.length,
      policyMs,
    });
    await recordEngineMetric(env, {
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
    characterName: env.CHARACTER_NAME,
  });
  const cardTextWithMood = charCard.cardText;

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

  // 每轮把语气提醒贴到用户消息最前面；实时类问题再叠加准确事实（不写入 D1）
  {
    const parts = [STYLE_REMINDER];
    if (isNowFactQuestion(content)) {
      parts.push(
        `【系统实时事实（最高优先级，不要复述这段格式）】${buildLiveFacts(now, ctx, weather)}。回答时间/天气/节假日时只以此为准，不要用历史或记忆里的旧值。`,
      );
    }
    const prefix = `${parts.join('\n\n')}\n\n`;
    userContent =
      typeof userContent === 'string'
        ? prefix + userContent
        : [{ type: 'text', text: prefix }, ...userContent];
  }

  const historyNote = historyRangeNote(history, now);
  const messages: DeepSeekMessage[] = [
    {
      role: 'system',
      content: buildSystemPrompt({
        now,
        ctx,
        memory: promptMemory.text,
        memoryMode: promptMemory.mode,
        weather,
        todaySummary,
        recentMemo,
        recalled,
        personaDrift,
        channel,
        characterCard: cardTextWithMood,
        voice: buildVoiceDirective(relationVals.intimacy),
        avoidOpeners,
        attitude,
        characterName: env.CHARACTER_NAME,
        userAddress: env.USER_ADDRESS,
      }) + (historyNote ? `\n\n${historyNote}` : ''),
    },
    // 最近 10 轮按时间从旧到新排列；每条带发送时间，模型才能判断上一句/上上句。
    // 单条只做超长保护（默认 2400 字，带文件 4200 字），不做过去那种 400 字过度压缩。
    ...history.map((m) => ({
      role: m.role,
      content: withHistoryTimestamp(
        compactHistoryMessage(
          m.content,
          m.content.includes('【文件：') ? HISTORY_FILE_MAX_CHARS : HISTORY_MESSAGE_MAX_CHARS,
        ),
        m.created_at,
      ),
    })),
    { role: 'user', content: userContent },
  ];

  // 4) 流式转发；流结束落库 + 计费
  return streamDeepSeek(env, messages, {
    appendUsageEvent: true,
    // ★ 不限制回复长度（8192 = 模型输出上限）
    maxTokens: 8192,
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
      // 把 id 一并返回：前端用它推进轮询游标，避免重复渲染同一轮
      return { cost, ids: { user: userRow.id, assistant: assistantId } };
    },
  });
}
