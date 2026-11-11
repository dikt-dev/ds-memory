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
import { loadLifeBlocks } from './chat-blocks';
import { loadPersonaDoc } from './persona-doc';
import { buildSystemPromptSplit, type MessageChannel, buildLiveFacts, isNowFactQuestion, isSilentEnd, silentEndRule } from './prompt';
import { resolvePersona } from './persona';
import { comfortNote, selfMentionNote, ticWarning } from './voice';
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
import {
  buildHistorySlice,
  CHAT_FULL_TURNS,
  conversationGapNote,
  loadSessionHistory,
} from './recent-context';
import { calcCost, loadPricing } from './pricing';
import { recordChatUsage } from './usage-stats';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
import { streamDeepSeek, type DeepSeekMessage } from './deepseek';
import { replyDelayMs } from './life/state';
import { formatWait } from './life/flush';
import { lifeNow } from './life/jobs';
import { getTodaySummary } from './summary';
import { loadImageDataUrl } from './media';
import { byteLength, parseRelationValues } from './memory-maintenance';
import { markProfileDirty } from './profile-cache';
import { buildCharacterCard } from './character-card';
import { facetsOf, processEmotionTurn } from './emotion-context';
import { stageFor } from './relation-facets';
import { readRelationStageLevel } from './relation-stage';
import { computeTemper } from './temper';
import { recentPainEvent } from './emotion-events';
import { loadKeepsakesBlock } from './keepsakes';
import { moodFromVector } from './emotion-vector';
import { readSessionFacts } from './session-facts';
import { actionDensityNote, buildVoiceDirective, buildVoiceTail, naggingComplaintNote, recentActions, recentOpeners, recentPhrases, selfRepeatScore, voiceModeOf } from './voice';
import { formatRecentMemoBlock, getRecentMemo, MEMO_MAX_ITEMS } from './recent-memory';
import { embedTexts, extractPromptMemory, recallMemoryForChat, stripDuplicateRecall } from './memory-index';
import { loadMemoryChunks } from './memory-context-store';
import { expandLinkedChunks } from './memory-links';
import { formatMemoryChunks, rankMemoryChunks, shouldRecallMemory } from './memory-domain';
import { normalizeAssistantText } from './openai';
import { budgetContext, clipCore, formatBudgetManifest } from './context-budget';
import { promisesBlock } from './memory-promises';
import { isMemoryQuestion, memoryAnswerHint } from './query-expand';
import { buildAttitudePolicy } from './attitude-policy';
import { packMemoryChunks } from './context-packer';
import { affectEngineFor, memoryEngineFor } from './engine-flags';
import { recordEngineMetric } from './engine-metrics';
import { logTrace } from './trace';
import { recordRequest } from './request-log';
import { promptFingerprint } from './prompt-fingerprint';
import { diaryPeekNote, pendingDiaryAsks, settleDiaryConsent } from './life/diary-job';
import { videoFailNote } from './media/bili-vision';

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
  opts: { reuseUserMessageId?: number; waitUntil?: (p: Promise<unknown>) => void } = {},
): Promise<Response> {
  if (!env.DEEPSEEK_API_KEY && !env.DASHSCOPE_API_KEY) {
    return Response.json({ error: '没有配置模型 key（DEEPSEEK_API_KEY / DASHSCOPE_API_KEY）' }, { status: 500 });
  }

  // 分段计时：只记数字不记内容，用来回答「这 10 秒到底花在哪」
  const tStart = Date.now();
  const timing: Record<string, number> = {};

  // 秒回不像人：她正忙着/睡着的时候，先等一会儿再把第一个字吐出来。
  // 放在这里而不是客户端，是因为网页和 App 走同一条链路，一处生效。
  await sleep(replyDelayMs(await lifeNow(env).then((s) => s.status).catch(() => 'free' as const)));
  timing.delayMs = Date.now() - tStart;

  // 0) 上一轮她提过的往事，如果这句是"对/记得"，就算一次确认复习
  void consumePendingRecall(env, content, now.getTime()).catch(() => {});
  // 用户又提了一次日记 → 之前拒过的那篇重新摆上桌，她这次可能改口
  // 日记给不给看由**她的回答**决定，不是由用户的措辞决定。
  // 之前拿用户输入判：用户问「可以给我看一下吗？」带问号 → 反问=拒绝，
  // 而她明明答了「好吧」，界面照样锁着。结算改到 onFinish 里。

  // 1) 组装上下文（先取历史，再落 user 消息，避免历史里重复出现本条）
  const dateKey = dateKeyInBeijing(now);
  // 这些读取互不依赖：并行发起，减少手机 QQ 场景的首字延迟。
  // 会话历史与记忆包互不依赖：并行取。
  const [session, pack] = await Promise.all([
    loadSessionHistory(env, now),
    buildMemoryPack(env, now, { channel, memoMaxItems: MEMO_MAX_ITEMS }),
  ]);
  timing.packMs = Date.now() - tStart;
  // 短期记忆 = 本次会话全部（只追加不滑窗，缓存才命得中）；超出上限才有提要
  // index.ts 已经把这句写进 D1 了，历史里会再出现一次——去掉，别让同一句发两遍
  const recordContentEarly = image ? [content, `[图片:${image.key}]`].filter(Boolean).join('\n') : content;
  const deduped = session.rows.filter(
    (m, i) =>
      !(
        i === session.rows.length - 1 &&
        m.role === 'user' &&
        (m.content === recordContentEarly || m.content === content)
      ),
  );
  // ★ 切成「原文 + 提要」：30 轮以内在原文里，更早的压成提要跟着易变段注入。
  //   以前超限是从数组里直接删，模型不知道自己少了一段——"刚聊过的"就这么消失了。
  const historySlice = buildHistorySlice(deduped, { fullTurns: CHAT_FULL_TURNS });
  const history = historySlice.rows;
  // 这场会话一共几轮、其中几轮只以提要形式在场
  const briefRounds = historySlice.rounds - historySlice.fullRounds;
  const { memory, dayCtxFile, weather, ctx, promptMemory, personaState, personaDrift } = pack;
  if (pack.weather) await attachWeather(env, dateKey, pack.weather, dayCtxFile);
  // 最近几条回复的开头：避免连续几轮用同一句开场白
  const assistantTexts = history.filter((m) => m.role === 'assistant').map((m) => m.content);
  const avoidOpeners = recentOpeners(assistantTexts);
  // 最近反复出现的口癖：连着说同一个词，是比开头重复更明显的模板感
  const avoidPhrases = recentPhrases(assistantTexts);
  // 括号动作连用（2026-11-09：围巾那条连续 6 次）
  const recentActs = recentActions(assistantTexts);
  // ★ 中期记忆（最近 24 小时）优先：它存在时就不再注入今日摘要，避免同一段内容发两遍。
  // 落在本会话时间范围内的条目不再注入——历史原文里已经有了（O4 去重）。
  // 打包层已经按会话起点和条数上限格式化好了（快照路径也保留原始 items，2026-11-08）；
  // 这里再 format 一次会在快照路径上把中期记忆清空。
  const recentMemo = pack.recentMemo;
  const todaySummary = pack.todaySummary;

  // ★ 按需检索：用当前消息 + 最近几条用户消息去档案里找相关往事（不命中就不占字节）
  const recallQuery = [
    content,
    ...history
      .filter((m) => m.role === 'user')
      .slice(-3)
      .map((m) => m.content),
  ].join(' ');
  // ★ 并行预取：人设、生活块、铭记、会话事实、日记提问都跟记忆召回互不依赖。
  //   以前一条条 await 排下来，光这里就吃掉 2.5~3 秒；现在让它们在召回那 1.6 秒里跑完。
  const factsPromise = readSessionFacts(env, now, dateKey);
  const keepsakesPromise = loadKeepsakesBlock(env).catch(() => '');
  const lifeBlocksPromise = loadLifeBlocks(env, now, content, history.slice(-6)).catch(() => ({
    residents: null,
    location: null,
    life: null,
  }));
  const personaTextPromise = loadPersonaDoc(env).catch(() => '');
  const asksPromise = pendingDiaryAsks(env).catch(() => []);

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
    // 已经注入的记忆：召回只在「提示词里没有」的候选上跑（2026-11-08）
    injectedText: clipCore(pack.promptMemory.text),
    nowMs: now.getTime(),
    // 指标写盘交给 waitUntil：不卡这一轮
    waitUntil: opts.waitUntil,
  });
  timing.recallMs = Date.now() - tStart;
  const recalledRaw = recall.text;
  // 复习计数：这一轮真正注入的条目被想起了一次（遗忘曲线靠它抵抗衰减）。
  void recordRecallUsage(env, recall.ids, now.getTime()).catch(() => {});
  void rememberPendingRecall(env, recall.ids, now.getTime()).catch(() => {});
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
    [...history.map((m) => m.content), recentMemo ?? '', promptMemory.text],
  );

  const affectEngine = affectEngineFor(env, channel);
  const contextBudget = budgetContext({
    core: promptMemory.text,
    recent: todaySummary ?? '',
    recentMemo: recentMemo ?? '',
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
    sessionRounds: historySlice.rounds,
    briefRounds,
    briefChars: historySlice.brief.length,
    recalledItems: recalled.split('\n').filter((line) => line.startsWith('- ')).length,
    hasMemo: Boolean(recentMemo),
    hasSummary: Boolean(todaySummary),
    budgetChars: contextBudget.totalChars,
    budget: formatBudgetManifest(contextBudget.manifest),
  });
  // 同一条 /api/chat 还有一条 http 记录（只有总耗时）；这条只记分段，回答「慢在哪一段」。
  // 只写计数与字节数，不写正文。
  // 埋点：不 await，失败也不影响回复
  recordRequest(env, {
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
      sessionRounds: historySlice.rounds,
      briefRounds,
      briefChars: historySlice.brief.length,
      recalledItems: recalled.split('\n').filter((line) => line.startsWith('- ')).length,
      hasMemo: Boolean(recentMemo),
      hasSummary: Boolean(todaySummary),
      recallTimedOut: recall.timedOut,
      budgetChars: contextBudget.totalChars,
    }),
  }).catch(() => {});

  // ★ 活人感：在落库本条前采集「距上次聊天间隔 + 今日轮数」
  const relationVals = parseRelationValues(memory);
  const facts = await factsPromise;
  const hourForCard = beijingHour(now);

  // ★ 情感系统：事件 → 情绪向量 → 5 轴微增量 → 情绪快照（先算，后面的状态卡要用它派生心情）
  // 判定 AI 需要知道谁在说话：只给它「他/你」交替的最近两轮，**不含**当前这句（函数自己会拼）
  const judgeContext = history
    .filter((m) => m.content !== content)
    .slice(-4)
    .map((m) => (m.role === 'user' ? '他：' : '你：') + m.content.replace(/\s+/g, ' ').slice(0, 120))
    .join('\n');
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
    judgeContext,
  // share_pain 也要复核：词典把问句和转述也记成「他在诉苦」，生效后她会莫名其妙心疼
  reviewSharePain: true,
  });

  // ★ 铭记：常驻注入，不参与召回。KV 缓存，避免每轮查 D1。
  const keepsakesBlock = await keepsakesPromise;

  // ★ 脾气：情绪 → 配合度。让她可以拒绝，而不是"委屈地答应"。
  // 他正在难受（最近 30 分钟内倒过苦水）：给她一句「先接住」，而不是让脾气变冷
  const pain = recentPainEvent(emotion.state.events, now.getTime());
  const careLine = pain
    ? '他在跟你倒苦水，不是在问办法：先接住，别讲道理、别急着给建议；可以追问一句具体发生了什么。'
    : null;
  const temper = computeTemper({
    vector: emotion.state.vector,
    facets: emotion.facets,
    wasIgnored: facts.wasIgnored,
    events: emotion.state.events,
    now: now.getTime(),
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
    stage: stageFor(facetsOf(relationVals), (await readRelationStageLevel(env)) ?? undefined),
  tone: resolvePersona(env).tone,
});
  const cardTextWithMood = charCard.cardText;

  // 2) 落用户消息（D1 只存文本，图片记 R2 路径）
  const recordContent = recordContentEarly;
  // 闸门补发时消息已经在库里了，复用它的 id，不再插一条（否则历史里会出现两条一样的话）
  let userId: number;
  if (opts.reuseUserMessageId) {
    userId = opts.reuseUserMessageId;
  } else {
    const userRow = await insertUserMessage(env, recordContent, now, { channel });
    userId = userRow.id;
    // 有新用户消息 → 用户画像需要重算（下次主动消息决策时生效）
    markProfileDirty(env).catch(() => {});
  }

  // 3) 发给 DeepSeek 的图片从 R2 读回（压缩后的版本）
  let userContent: DeepSeekMessage['content'] = content;
  if (image) {
    const loaded = await loadImageDataUrl(env, image.key);
    userContent = [
      { type: 'text', text: content || '请看看这张图片。' },
      ...(loaded ? [{ type: 'image_url' as const, image_url: { url: loaded.dataUrl } }] : []),
    ];
  }

  // ★ 贴在用户消息最前面的几块（注意力最强）：记忆题直答 → 未完成的约定 → 召回往事。
  //   原来这些只在 App/QQ 那条路径上有，网页端一句都没有——同一套记忆，两个渠道两种记性（2026-11-08）。
  const userPrefixParts: string[] = [];
  if (isMemoryQuestion(content)) {
    userPrefixParts.push(memoryAnswerHint(
      // 覆盖率短路之后 recall 经常是空的，但长期记忆整段在提示词里——
      // 用「召回」判断会误伤成「记忆里没有」，于是她每句都先认怂（2026-11-08 实测）
      Boolean(contextBudget.recall.trim() || contextBudget.core.trim()),
    ));
  }
  const promiseText = promisesBlock(memory ?? '').trim();
  if (promiseText) userPrefixParts.push(promiseText);
  if (contextBudget.recall.trim()) {
    userPrefixParts.push(
      '你记得这些（他以前说过的、一起经历过的，可能和这轮有关）：\n' +
        contextBudget.recall.trim() +
        '\n（自然地用，不要逐条念出来；这轮用不上也不用硬提）',
    );
  }
  if (userPrefixParts.length > 0) {
    const prefix = `${userPrefixParts.join('\n\n')}\n\n`;
    userContent =
      typeof userContent === 'string'
        ? prefix + userContent
        : [{ type: 'text', text: prefix }, ...userContent];
  }

  // 实时类问题才贴准确事实（不写入 D1）；语气不再每轮提醒
  if (isNowFactQuestion(content)) {
    const prefix =
      `【系统实时事实（最高优先级，不要复述这段格式）】${buildLiveFacts(now, ctx, weather)}。回答时间/天气/节假日时只以此为准，不要用历史或记忆里的旧值。\n\n`;
    userContent =
      typeof userContent === 'string'
        ? prefix + userContent
        : [{ type: 'text', text: prefix }, ...userContent];
  }

  // 他被压着的那批消息：现在这条可能就是到点补发的，告诉她等了多久
  const lastRow = history[history.length - 1];
  // 补发链路（flush）已经在正文里写了等待时长，这里不重复说第二遍
  const pendingWait =
    lastRow && lastRow.role === 'user' && lastRow.created_ms && !content.includes('现在才看到')
      ? `\n\n【他等的时间】他上一条发出到现在已经 ${formatWait(now.getTime() - lastRow.created_ms)}，你一直没回（在忙或睡着了）。回的时候先随口带一句，别装作刚才发生，也不要报时间点；别老用同一个说法带过。`
      : '';
  const historyNote = [
    historyRangeNote(history, now, briefRounds),
    conversationGapNote(history, now),
  ]
    .filter(Boolean)
    .join('\n');
  // ★ 稳定段（人设+长期记忆）单独作为第一条 system，每轮字节一致才能吃到缓存命中价；
  // 时间/心情/召回/摘要这些每轮都变的放到最后一条 system，紧贴用户消息。
  // 她此刻在干什么：读不到就当没有，聊天行为和以前一模一样
  const lifeBlocks = await lifeBlocksPromise;
  const recentReplies = history.filter((m) => m.role === 'assistant').map((m) => m.content);
  const tic = ticWarning(recentReplies, resolvePersona(env).selfCall);
  // 连着几条都在顺着他说话，就推一句把话头拉回她自己身上
  const selfNote = selfMentionNote(recentReplies);
  // 他在说难受的事：站队优先，别评价、别给建议
  const comfort = comfortNote(content);
  // 两条提醒会打架：一个要她"把话头拉回自己"，一个要她"第一句先站队"。
  // 他难受的时候以站队为准，自己那点事先放一放。
  const selfNoteFinal = comfort ? null : selfNote;
  // 用户在 App 里点了「问问她」之后，日记是 pending。没人告诉她要开口，
  // 于是点完什么都不会发生。这里补一句，让她在下一句里自己决定给不给看。
  const asks = await asksPromise;
  // 她在 App 里点「问问她」之后需要她开口。但只给一句「你想不想给看」不够——
  // 人设里没有「她会写日记」这件事，模型会直接否认日记存在（实测："本小姐哪来的日记啊"）。
  // 所以这里给的是**事实**加约束，不是提问。
  // ★ 被问的每一篇都要带上她自己写的备忘摘要：没有内容依据，
  //   她只能凭印象赌一篇，「答应看」和「其实写了什么」就对不上。
  // 他嘴上一句「看一眼」也算问：手边没有原文时给禁令，有原文时给原文（2026-11-10）。
  // 带上最近几句用户原话——实测要日记的请求常常是「看一眼么」，"日记"两个字在前面那一轮。
  const diaryContext = [content, ...history.filter((m) => m.role === 'user').slice(-3).map((m) => m.content)].join(' ');
  const diaryPeek = await diaryPeekNote(env, diaryContext).catch(() => null);
  // 视频没解析出来时，把「没看成」当成事实告诉她（2026-11-11）。
  // 否则那条失败只留在 KV 里，她只能靠常识推断——实测推断出「昨晚看完了」。
  const videoFail = await videoFailNote(env).catch(() => null);
  const diaryAskNote = asks.length
    ? [
        `【日记】用户在问能不能看：${asks.map((a) => a.date.slice(2)).join('、')}。`,
        ...asks
          .filter((a) => a.summary)
          .map((a) => `- ${a.date.slice(2)} 那篇，你当时给自己留的备忘：${a.summary}`),
        '这些是你写的时候给自己留的备忘，不是给他看的文案——别念出来，也别逐条复述。',
        '你可以答应看全部、只给看一眼、或者拒绝。日记是存在的，别否认自己写过。说一两句就够了。',
      ].join('\n')
    : null;
  const personaDoc = await personaTextPromise;
  const promptSplit = buildSystemPromptSplit({
        now,
        userText: content,
        personaDoc,
        ctx,
        memory: contextBudget.core,
        memoryMode: promptMemory.mode,
        weather,
        todaySummary: contextBudget.recent,
        recentMemo: contextBudget.recentMemo,
        recalled: contextBudget.recall,
        personaDrift,
        channel,
        characterCard: cardTextWithMood,
        voice: buildVoiceDirective(relationVals.intimacy, voiceModeOf(env)),
    voiceTail: buildVoiceTail(voiceModeOf(env)),
        // 网页端已用浏览器 speechSynthesis 播放，允许模型输出 [语音] 段
        voiceReply: true,
        avoidOpeners,
    avoidPhrases,
        attitude,
        temper: temper.line,
        care: careLine,
        keepsakes: keepsakesBlock,
        characterName: env.CHARACTER_NAME,
        userAddress: env.USER_ADDRESS,
        residents: lifeBlocks.residents,
        location: lifeBlocks.location,
        persona: resolvePersona(env),
        life:
          [lifeBlocks.life, tic, selfNoteFinal, diaryAskNote, diaryPeek, videoFail, actionDensityNote(recentReplies)]
            .filter(Boolean)
            .join('\n\n') || null,
  });
  // 站队这条放在**最后一条 system 的末尾**：他难受时这是最该压过他惯性的一句，
  // 埋在时间/天气那一段中间时，模型会先去描述他的处境。
  // 2026-11-10：不再把动作原文念给她（「把抹布搭回桶边」）——念一遍她下一轮照样用。
  const actionNote = recentActs.length > 0
    ? '这一轮换个动作，或者干脆不写动作——连着几条都是同一个动作，像剧本。'
    : '';
  const volatileBlock = [
    promptSplit.volatile,
    historyNote + pendingWait,
    // 更早的轮次：只给提要。放在易变段（历史之后）→ 前缀缓存不受影响。
    historySlice.brief,
    comfort,
    actionNote,
    // 他当场嫌她管太宽：只影响这一轮（memory.md 要到明天 04:00 才更新）
    naggingComplaintNote(content),
  ]
    .filter(Boolean)
    .join('\n\n');
  const messages: DeepSeekMessage[] = [
    {
      role: 'system',
      content: promptSplit.stable + silentEndRule(channel),
    },
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
  timing.buildMs = Date.now() - tStart;
  return streamDeepSeek(env, messages, {
    appendUsageEvent: true,
    timing,
    // ★ 不限制回复长度（8192 = 模型输出上限）
    maxTokens: 8192,
    onFinish: async (text, usage) => {
      // 计时落库：只写数字，事后能回答「这 10 秒花在哪一段」
      recordRequest(env, {
        requestId: requestId ?? 'none',
        kind: 'chat',
        path: '/api/chat#timing',
        ms: Date.now() - tStart,
        channel,
        ok: true,
        detail: JSON.stringify({
          ...timing,
          totalMs: Date.now() - tStart,
          // 输入指纹：逐字复读排查用（2026-11-10）
          promptHash: promptFingerprint(messages).hash,
          promptChars: promptFingerprint(messages).chars,
          tailIds: [...history.slice(-3).map((m) => m.id), userId ?? 0],
          // 复读观测：相邻两条她自己回复的 3-gram 相似度（只记录，不参与生成）
          selfRepeat: selfRepeatScore(assistantTexts),
        }),
      }).catch(() => {});
      let cost = 0;
      let assistantId: number | undefined;
      const silent = isSilentEnd(text) && (channel === 'mobile' || channel === 'web');
      const stored = silent ? '' : normalizeAssistantText(text);
      // 她的这句才决定日记给不给看（「好吧/拿去」= 同意，「不给/想得美」= 拒绝）
      if (stored) {
        void settleDiaryConsent(env, content, stored).catch(() => {});
      }
      if (!silent && stored) {
        // 费用与 token 随 INSERT 一次写入（少一条 UPDATE）
        const saved = await insertAssistantReply(env, stored, userId, now, {
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
      return { cost, ids: { user: userId, assistant: assistantId } };
    },
  });
}