/**
 * 聊天链路（网页端）：组装上下文 → DeepSeek 流式请求 → SSE 透传给前端。
 * 落库顺序：先读历史（不含本条）→ 落 user 消息 → 流结束后落 assistant 回复并计费。
 * 图片：已压缩存入 R2（images/日期/时间戳.jpg），发给 DeepSeek 时从 R2 读回；D1 只记录 R2 路径。
 */
import { recordAction } from './memory-actions';
import { resolveRecall } from './memory-engine';
import type { Env } from './types';
import { buildPromptMemoryFor } from './memory-index';
import { shouldSkipMemoryRecall, buildMemoryPack  } from './context-pack';
import { consumePendingRecall, looksLikePinRequest, recordRecallUsage, rememberPendingRecall, setChunkPinned } from './memory-rehearsal';
import { buildSystemPromptSplit, type MessageChannel, buildLiveFacts, isNowFactQuestion, isSilentEnd, silentEndRule, STYLE_REMINDER } from './prompt';
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
import { conversationGapNote, loadSessionHistory } from './recent-context';
import { calcCost, loadPricing } from './pricing';
import { recordChatUsage } from './usage-stats';
import { streamDeepSeek, type DeepSeekMessage } from './deepseek';
import { getTodaySummary } from './summary';
import { loadImageDataUrl } from './media';
import { byteLength, parseRelationValues } from './memory-maintenance';
import { markProfileDirty } from './profile-cache';
import { buildCharacterCard } from './character-card';
import { facetsOf, processEmotionTurn } from './emotion-context';
import { computeTemper } from './temper';
import { loadKeepsakesBlock } from './keepsakes';
import { moodFromVector } from './emotion-vector';
import { readSessionFacts } from './session-facts';
import { buildVoiceDirective, recentOpeners } from './voice';
import { formatRecentMemoBlock, getRecentMemo, MEMO_MAX_ITEMS } from './recent-memory';
import { embedTexts, extractPromptMemory, recallMemoryForChat, stripDuplicateRecall } from './memory-index';
import { loadMemoryChunks } from './memory-context-store';
import { expandLinkedChunks } from './memory-links';
import { formatMemoryChunks, rankMemoryChunks, shouldRecallMemory } from './memory-domain';
import { normalizeAssistantText } from './openai';
import { budgetContext, formatBudgetManifest } from './context-budget';
import { buildAttitudePolicy } from './attitude-policy';
import { packMemoryChunks } from './context-packer';
import { affectEngineFor, memoryEngineFor } from './engine-flags';
import { recordEngineMetric } from './engine-metrics';
import { logTrace } from './trace';
import { recordRequest } from './request-log';

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

  // 0) 上一轮她提过的往事，如果这句是"对/记得"，就算一次确认复习
  void consumePendingRecall(env, content, now.getTime());

  // 1) 组装上下文（先取历史，再落 user 消息，避免历史里重复出现本条）
  const dateKey = dateKeyInBeijing(now);
  // 这些读取互不依赖：并行发起，减少手机 QQ 场景的首字延迟。
  // 会话历史与记忆包互不依赖：并行取。
  const [session, pack] = await Promise.all([
    loadSessionHistory(env, now),
    buildMemoryPack(env, now, { channel }),
  ]);
  // 短期记忆 = 本次会话全部（只追加不滑窗，缓存才命得中）；超出上限才有提要
  const history = session.rows;
  const { memory, dayCtxFile, weather, ctx, promptMemory, personaState, personaDrift } = pack;
  if (pack.weather) await attachWeather(env, dateKey, pack.weather, dayCtxFile);
  // 最近几条回复的开头：避免连续几轮用同一句开场白
  const avoidOpeners = recentOpeners(history.filter((m) => m.role === 'assistant').map((m) => m.content));
  // ★ 中期记忆（最近 24 小时）优先：它存在时就不再注入今日摘要，避免同一段内容发两遍。
  // 落在本会话时间范围内的条目不再注入——历史原文里已经有了（O4 去重）。
  const sessionStartMs = history[0]?.created_ms;
  const recentMemo = formatRecentMemoBlock(pack.recentMemoRaw, MEMO_MAX_ITEMS, sessionStartMs);
  const todaySummary = recentMemo ? null : pack.todaySummary;

  // ★ 按需检索：用当前消息 + 最近几条用户消息去档案里找相关往事（不命中就不占字节）
  const recallQuery = [
    content,
    ...history
      .filter((m) => m.role === 'user')
      .slice(-3)
      .map((m) => m.content),
  ].join(' ');
  const memoryEngine = memoryEngineFor(env, channel);
  // 门控 / deadline / shadow-next / 输出封顶都在 resolveRecall 里，三个渠道共用一份
  const recall = await resolveRecall(env, {
    query: recallQuery,
    focus: history.slice(-8).map((m) => m.content).join(' '),
    mode: memoryEngine,
    channel,
    requestId,
    // 全量记忆已经带上所有 memory 条目，召回只补档案层的旧事
    skipMemorySource: shouldSkipMemoryRecall(pack),
    nowMs: now.getTime(),
  });
  const recalledRaw = recall.text;
  // 复习计数：这一轮真正注入的条目被想起了一次（遗忘曲线靠它抵抗衰减）。
  void recordRecallUsage(env, recall.ids, now.getTime());
  void rememberPendingRecall(env, recall.ids, now.getTime());
  // 她来决定铭记什么：用户明确说"记住这件事"时，给命中的那条上锁
  if (recall.ids.length > 0 && looksLikePinRequest(content)) {
    const target = recall.ids[0];
    void (async () => {
      if (await setChunkPinned(env, target, true)) {
        await recordAction(env, {
          actor: 'agent',
          kind: 'memory.pin',
          intent: '用户明确要求记住这件事，这条记忆上了铭记锁',
          evidence: [target],
          diff: 'chunk ' + target + ' 上铭记锁',
          before: '可淡忘',
          after: '铭记中',
          revertible: true,
        }, now.getTime()).catch(() => {});
      }
    })();
  }

  const recalled = stripDuplicateRecall(
    recalledRaw,
    [...history.map((m) => m.content), recentMemo, promptMemory.text].filter(Boolean),
  );

  const affectEngine = affectEngineFor(env, channel);
  const contextBudget = budgetContext({
    core: promptMemory.text,
    recent: todaySummary ?? '',
    rollup: recentMemo ?? '',
    recall: recalled,
  });
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
    budgetChars: contextBudget.totalChars,
    budget: formatBudgetManifest(contextBudget.manifest),
  });
  // 同一条 /api/chat 还有一条 http 记录（只有总耗时）；这条只记分段，回答「慢在哪一段」。
  // 只写计数与字节数，不写正文。
  await recordRequest(env, {
    requestId: requestId ?? 'none',
    kind: 'chat',
    path: '/api/chat#recall',
    ms: Math.round(recall.ms),
    channel,
    ok: !recall.timedOut,
    detail: JSON.stringify({
      memoryEngine,
      promptBytes: byteLength(promptMemory.text),
      historyRounds: groupTurns(history).length,
      recalledItems: recalled.split('\n').filter((line) => line.startsWith('- ')).length,
      hasMemo: Boolean(recentMemo),
      hasSummary: Boolean(todaySummary),
      recallTimedOut: recall.timedOut,
      budgetChars: contextBudget.totalChars,
    }),
  }).catch(() => {});

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
    // 只在规则判出负向事件时才会真的调 AI（见 processEmotionTurn）
    allowAiReview: true,
  });

  // ★ 铭记：常驻注入，不参与召回。KV 缓存，避免每轮查 D1。
  const keepsakesBlock = await loadKeepsakesBlock(env).catch(() => '');

  // ★ 脾气：情绪 → 配合度。让她可以拒绝，而不是"委屈地答应"。
  const temper = computeTemper({
    vector: emotion.state.vector,
    facets: emotion.facets,
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

  const historyNote = [historyRangeNote(history, now), conversationGapNote(history, now)]
    .filter(Boolean)
    .join('\n');
  // ★ 稳定段（人设+长期记忆）单独作为第一条 system，每轮字节一致才能吃到缓存命中价；
  // 时间/心情/召回/摘要这些每轮都变的放到最后一条 system，紧贴用户消息。
  const promptSplit = buildSystemPromptSplit({
        now,
        ctx,
        memory: contextBudget.core,
        memoryMode: promptMemory.mode,
        weather,
        todaySummary: contextBudget.recent,
        recentMemo: contextBudget.rollup,
        recalled: contextBudget.recall,
        personaDrift,
        channel,
        characterCard: cardTextWithMood,
        voice: buildVoiceDirective(relationVals.intimacy),
        // 网页端已用浏览器 speechSynthesis 播放，允许模型输出 [语音] 段
        voiceReply: true,
        avoidOpeners,
        attitude,
        temper: temper.line,
        keepsakes: keepsakesBlock,
        characterName: env.CHARACTER_NAME,
        userAddress: env.USER_ADDRESS,
  });
  const volatileBlock = [promptSplit.volatile, historyNote].filter(Boolean).join('\n\n');
  const messages: DeepSeekMessage[] = [
    {
      role: 'system',
      content: promptSplit.stable + silentEndRule(channel),
    },
    // 会话太长被压掉的那段：一次提要，之后不再变（变了会打断前缀缓存）
    ...(session.brief ? [{ role: 'system' as const, content: session.brief }] : []),
    // 会话内全部历史按时间从旧到新排列；每条带发送时间，模型才能判断上一句/上上句。
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
    // 易变段放最后：时间、心情、召回、摘要每轮都在变，放在前缀里会让缓存全部失效
    ...(volatileBlock ? [{ role: 'system' as const, content: volatileBlock }] : []),
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
      const silent = isSilentEnd(text) && (channel === 'mobile' || channel === 'web');
      const stored = silent ? '' : normalizeAssistantText(text);
      if (!silent && stored) {
        // 费用与 token 随 INSERT 一次写入（少一条 UPDATE）
        const saved = await insertAssistantReply(env, stored, userRow.id, now, {
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
      // 记账（失败的 session 也记，成本已经产生）：命中/未命中分开，才能算命中率
      if (usage) {
        await recordChatUsage(env, {
          channel,
          model: env.DEEPSEEK_MODEL,
          promptHit: usage.prompt_cache_hit_tokens ?? 0,
          promptMiss: usage.prompt_cache_miss_tokens ?? 0,
          completion: usage.completion_tokens ?? 0,
          costRmb: calcCost(usage, loadPricing(env), now),
        });
      }
      // 把 id 一并返回：前端用它推进轮询游标，避免重复渲染同一轮
      return { cost, ids: { user: userRow.id, assistant: assistantId } };
    },
  });
}
