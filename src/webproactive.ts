/**
 * AI 主动消息（v2：打分决策 + 事由驱动）。
 *
 * 与 v1 的区别：
 * - v1：到随机时间就发，不考虑用户状态
 * - v2：先收集信号（活跃时段、静默期、待跟进事项、天气变化…）→ 打分 → 达标才发
 *
 * 工作流：
 * 1. cron 每 5 分钟 tick；
 * 2. 检查时间窗口（07:45-08:15 / 22:45-23:15 / 09:00-22:30 随机）；
 * 3. 收集用户画像与环境信号，调用 decideProactive() 打分；
 * 4. 分数达标 → 生成消息（带事由）→ 落库 + 记录 proactive_log；
 * 5. 不达标 → 跳过（大多数时候都是这个结果）。
 */
import type { Env } from './types';
import { dateKeyInBeijing, isoInBeijing } from './date';
import { buildBaseSystemPrompt } from './prompt';
import { getMemory } from './memory';
import { fetchWeather } from './weather';
import { getOrCreateDayContext, type DayContextFile } from './context';
import { getTodaySummary } from './summary';
import { recentMessages, recentProactiveMessages, insertProactiveMessage, updateMessageUsage } from './db';
import { parseRelationValues } from './memory-maintenance';
import { enqueueProactive } from './queue';
import { completeDeepSeek } from './deepseek';
import {
  decideProactive,
  extractPendingTopics,
  type Decision,
  type EnvironmentSignal,
  type UserProfile,
} from './proactive-engine';
import { getCachedProfile, setCachedProfile, getHeartbeat, getOfflineAlertedAt, setOfflineAlertedAt } from './profile-cache';
import { analyzeMood, moodToneHint } from './mood';
import { analyzeMoodSmart } from './mood-ai';
import { computeStreak, countMemoryEntries, detectMilestones, getFirstChatDate } from './milestone';
import { feedbackCooldownMultiplier, getFeedbackStats } from './feedback';
import {
  PROACTIVE_WINDOWS,
  RANDOM_WINDOW,
  beijingMinutes,
  currentSlot,
  deliverProactive,
  randomCountFor,
  randomTargetMinutes,
  targetMinutesFor,
} from './proactive';
import { buildCharacterCard } from './character-card';
import { buildVoiceDirective } from './voice';
import { formatRecentMemoBlock, getRecentMemo } from './recent-memory';
import { extractCoreMemory, recallMemoryForChat, stripDuplicateRecall } from './memory-index';
import { buildPersonaDriftLine, loadPersonaState } from './persona-drift';
import { readSessionFacts } from './session-facts';
import { facetsOf, processEmotionTurn } from './emotion-context';
import { moodFromVector } from './emotion-vector';

export interface ProactiveResult {
  skipped?: string;
  sent?: boolean;
  message?: string;
  error?: string;
  kind?: string;
  score?: number;
  reasons?: string[];
}

/** 收集用户行为画像（优先读 KV 缓存，脏了才重算）。 */
async function collectUserProfile(env: Env, now: Date): Promise<UserProfile> {
  // ① 缓存命中
  const cached = await getCachedProfile(env);
  if (cached) {
    // 动态字段（距上次消息/主动消息）必须实时算
    return refreshDynamicFields(env, now, cached);
  }

  // ② 重算活跃时段分布
  const hourly = new Array(24).fill(0) as number[];
  const since = new Date(now.getTime() - 14 * 86400000);
  const rows = await env.DB.prepare(
    `SELECT created_at FROM messages WHERE role = 'user' AND created_ms >= ?`,
  )
    .bind(since.getTime())
    .all<{ created_at: string }>();

  for (const r of rows.results ?? []) {
    const m = /T(\d{2}):/.exec(r.created_at);
    if (m) hourly[Number(m[1]) % 24] += 1;
  }
  const totalMessages = (rows.results ?? []).length;

  const profile = await refreshDynamicFields(env, now, {
    hourlyActivity: hourly,
    totalMessages,
  });

  await setCachedProfile(env, profile).catch(() => {});
  return profile;
}

/** 实时计算"距上次消息/主动消息"这类动态字段。 */
async function refreshDynamicFields(
  env: Env,
  now: Date,
  base: { hourlyActivity: number[]; totalMessages: number },
): Promise<UserProfile> {
  const lastUser = await env.DB.prepare(
    `SELECT created_ms FROM messages WHERE role = 'user' ORDER BY id DESC LIMIT 1`,
  ).first<{ created_ms: number }>();
  const minutesSinceLastUserMsg = lastUser ? (now.getTime() - lastUser.created_ms) / 60000 : null;

  const lastProactive = await env.DB.prepare(
    `SELECT id, created_ms FROM messages WHERE turn_type = 'proactive' ORDER BY id DESC LIMIT 1`,
  ).first<{ id: number; created_ms: number }>();
  const minutesSinceLastProactive = lastProactive ? (now.getTime() - lastProactive.created_ms) / 60000 : null;

  let repliesAfterLastProactive = 0;
  if (lastProactive) {
    const r = await env.DB.prepare(
      `SELECT COUNT(*) AS c FROM messages WHERE role = 'user' AND id > ?`,
    )
      .bind(lastProactive.id)
      .first<{ c: number }>();
    repliesAfterLastProactive = r?.c ?? 0;
  }

  return {
    hourlyActivity: base.hourlyActivity,
    totalMessages: base.totalMessages,
    minutesSinceLastUserMsg,
    minutesSinceLastProactive,
    repliesAfterLastProactive,
  };
}

/** 收集环境信号。 */
async function collectEnvironment(env: Env, now: Date, dayCtx: DayContextFile): Promise<EnvironmentSignal> {
  const hour = Math.floor(beijingMinutes(now) / 60);
  const dateKey = dateKeyInBeijing(now);

  // 天气变化：对比当天 context 里已记录的天气与当前实时天气
  let weatherChanged = false;
  try {
    // 复用调用方已读到的 dayCtx，避免同一个 tick 里重复读一次 R2
    const current = (await getOrCreateDayContext(env, dateKey, dayCtx)).weather;
    const live = await fetchWeather(env);
    if (current && live) {
      const tempDiff = Math.abs(current.temp_c - live.temp_c);
      const descDiff = current.desc !== live.desc;
      weatherChanged = tempDiff >= 6 || descDiff;
    }
  } catch {
    /* 忽略 */
  }

  // 特殊日期：法定节假日当天（元旦/春节/国庆…），普通周末不算
  const isSpecialDay = dayCtx.is_holiday && dayCtx.holiday_note !== '周末';

  return { hour, isRestDay: dayCtx.is_holiday, weatherChanged, isSpecialDay };
}

/** 生成带事由的主动消息。 */
async function generateProactive(
  env: Env,
  now: Date,
  decision: Decision,
  scene: string,
  toneHint: string,
): Promise<{ text: string; cost: number; promptTokens: number; completionTokens: number } | { error: string }> {
  const dateKey = dateKeyInBeijing(now);
  const [memory, weather, dayCtx, recentMemoRaw, todaySummaryRaw, history, recentProactive] = await Promise.all([
    getMemory(env),
    fetchWeather(env),
    getOrCreateDayContext(env, dateKey),
    getRecentMemo(env),
    getTodaySummary(env, dateKey),
    recentMessages(env, 12),
    recentProactiveMessages(env, 6),
  ]);
  const relation = parseRelationValues(memory);
  // 中期记忆优先：它存在时跳过今日摘要，避免重复
  const recentMemo = formatRecentMemoBlock(recentMemoRaw);
  const todaySummary = recentMemo ? null : todaySummaryRaw;
  const ctx = {
    date: dayCtx.date,
    weekday: dayCtx.weekday,
    is_holiday: dayCtx.is_holiday,
    holiday_note: dayCtx.holiday_note,
  };

  // ★ 活人感：状态卡 + 口语化 + 情绪残留，让"主动开口"也符合"当下的它"
  const hourNow = Number(
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', hour12: false }).format(now),
  ) % 24;
  const facts = await readSessionFacts(env, now, dateKey);
  const envMonthNow = Number(
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', month: '2-digit' }).format(now),
  );

  // ★ 情感系统：主动开口也要带上「它此刻的情绪」（环境非对话驱动）；先算，心情由它派生
  const emotion = await processEmotionTurn({
    env,
    now: now.getTime(),
    base: facetsOf(relation),
    userText: '',
    environment: { hour: hourNow, isRestDay: dayCtx.is_holiday, weather, month: envMonthNow },
    wasIgnored: facts.wasIgnored,
  });
  const effectiveMood = moodFromVector(emotion.state.vector);
  const charCard = buildCharacterCard({
    hour: hourNow,
    hoursSinceLastContact: facts.hoursSinceLastContact,
    mood: effectiveMood,
    affinity: relation.affinity,
    intimacy: relation.intimacy,
    todayTurns: facts.todayTurns,
    dateKey,
    wasIgnored: facts.wasIgnored,
    ignoredMessage: facts.ignoredMessage,
  });
  const cardText = charCard.cardText;
  const personaDrift = buildPersonaDriftLine(await loadPersonaState(env));
  // 主动消息也带上相关往事：用最近几条对话当检索词
  const focus = history.slice(-8).map((m) => m.content).join(' ');
  const recalledRaw = await recallMemoryForChat(
    env,
    history
      .slice(-4)
      .map((m) => m.content)
      .join(' '),
    undefined,
    focus,
  );
  const recalled = stripDuplicateRecall(
    recalledRaw,
    [...history.map((m) => m.content), recentMemo].filter(Boolean),
  );

  const systemPrompt = buildBaseSystemPrompt({
    now,
    ctx,
    memory: extractCoreMemory(memory),
    weather,
    todaySummary,
    recentMemo,
    recalled,
    personaDrift,
    channel: 'web',
    characterCard: cardText,
    voice: buildVoiceDirective(relation.intimacy),
    attitude: emotion.snapshot,
  });

  const historyText =
    history.length > 0
      ? history.map((m) => `${m.role === 'user' ? '用户' : '助手'}：${m.content}`).join('\n')
      : '（无）';
  const recentText =
    recentProactive.length > 0 ? recentProactive.map((m) => `- ${m.content}`).join('\n') : '（无）';

  // ★ 事由驱动：把决策引擎算出的理由和话题明确告诉 AI
  const topicBlock =
    decision.topics.length > 0
      ? `\n## 本次主动消息的事由（优先围绕这些）\n${decision.topics.map((t) => `- ${t}`).join('\n')}`
      : '\n## 本次主动消息的事由\n（无具体事由，可以随口聊聊，但要自然、简短）';

  const system = `${systemPrompt}

## 最近对话
${historyText}
${topicBlock}

## 主动消息任务
现在是${scene}。请主动对用户说一句话（不要等用户先开口）。

要求：
- 只发一句话，最好不超过 40 字；像真人在微信上随手发的一条，不要长篇大论；
- ${decision.topics.length > 0 ? '优先围绕上面的事由，但不要说"根据记录"这类元话术；' : '可以分享一个想法、提一句天气、或问一句近况；'}
- 不要重复"最近已主动发送"里的内容；
- 只输出消息正文，不要解释、引号或前缀。
${toneHint ? '- ' + toneHint : ''}

最近已主动发送：
${recentText}`;

  const result = await completeDeepSeek(
    env,
    [
      { role: 'system', content: system },
      { role: 'user', content: '（系统定时触发：请主动说点什么）' },
    ],
    now,
    200,
  );
  if ('error' in result) return { error: result.error };

  const text = result.text
    .trim()
    .replace(/^[“”"'‘’\s]+|[“”"'‘’\s]+$/g, '')
    .replace(/^(消息|内容|回复)[:：]\s*/, '')
    .trim()
    .slice(0, 120);
  if (!text) return { error: '生成内容为空' };

  return {
    text,
    cost: result.cost,
    promptTokens: (result.usage?.prompt_cache_hit_tokens ?? 0) + (result.usage?.prompt_cache_miss_tokens ?? 0),
    completionTokens: result.usage?.completion_tokens ?? 0,
  };
}

/** 尝试占用某个时段（数据库唯一约束实现幂等）。 */
async function claimSlot(env: Env, dateKey: string, slotKey: string, kind: string): Promise<boolean> {
  try {
    await env.DB.prepare(
      `INSERT INTO proactive_log (date_key, slot_key, kind, status, created_at)
       VALUES (?, ?, ?, 'sent', ?)`,
    )
      .bind(dateKey, slotKey, kind, isoInBeijing())
      .run();
    return true;
  } catch {
    return false;
  }
}

async function finishSlot(
  env: Env,
  dateKey: string,
  slotKey: string,
  opts: { messageId?: number; status: 'sent' | 'queued' | 'failed'; detail?: string },
): Promise<void> {
  await env.DB.prepare(
    'UPDATE proactive_log SET message_id = ?, status = ?, detail = ? WHERE date_key = ? AND slot_key = ?',
  )
    .bind(opts.messageId ?? null, opts.status, opts.detail ?? null, dateKey, slotKey)
    .run()
    .catch(() => {});
}

async function releaseSlot(env: Env, dateKey: string, slotKey: string): Promise<void> {
  await env.DB.prepare('DELETE FROM proactive_log WHERE date_key = ? AND slot_key = ?')
    .bind(dateKey, slotKey)
    .run()
    .catch(() => {});
}

/** 生成并落库一条主动消息。 */
async function emit(
  env: Env,
  now: Date,
  dateKey: string,
  slotKey: string,
  kind: 'morning' | 'evening' | 'random',
  scene: string,
): Promise<ProactiveResult> {
  if (!(await claimSlot(env, dateKey, slotKey, kind))) {
    return { skipped: '该时段今天已发送', kind };
  }

  // 决策：收集信号 → 打分
  const [profile, dayCtx, memory] = await Promise.all([
    collectUserProfile(env, now),
    getOrCreateDayContext(env, dateKey),
    getMemory(env),
  ]);
  const environment = await collectEnvironment(env, now, dayCtx);
  const pendingTopics = extractPendingTopics(memory, now);
  const level = (env.PROACTIVE_LEVEL as 'quiet' | 'normal' | 'active') || 'normal';

  // ★ 情绪感知：取最近 6 条用户消息分析
  const recentUserMsgs = await env.DB.prepare(
    `SELECT content FROM messages WHERE role = 'user' ORDER BY id DESC LIMIT 6`,
  ).all<{ content: string }>();
  // ★ 情绪感知：先关键词分析；命中否定/转折/反讽等歧义时用 Workers AI 复核（免费额度）
  const moodText = (recentUserMsgs.results ?? []).map((r) => r.content).join('\n');
  const mood = await analyzeMoodSmart(env, moodText).catch(() => analyzeMood(moodText));

  // ★ 里程碑：认识天数 / 连续聊天 / 记忆条目数
  const [firstChatDate, streakDays] = await Promise.all([getFirstChatDate(env), computeStreak(env, dateKey)]);
  const milestones = detectMilestones({
    firstChatDate,
    today: dateKey,
    streakDays,
    memoryEntryCount: countMemoryEntries(memory),
  });

  // ★ 历史反馈：回复率低则拉长冷却
  const fbStats = await getFeedbackStats(env, 30).catch(() => null);
  const feedbackMultiplier = fbStats ? feedbackCooldownMultiplier(fbStats) : 1;

  const decision = decideProactive({
    profile,
    env: environment,
    pendingTopics,
    level,
    mood,
    milestones,
    feedbackMultiplier,
    slot: kind === 'morning' || kind === 'evening' ? kind : 'random',
  });
  if (!decision.shouldSend) {
    await releaseSlot(env, dateKey, slotKey);
    return {
      skipped: `分数 ${decision.score} 未达阈值`,
      kind,
      score: decision.score,
      reasons: decision.reasons,
    };
  }

  const generated = await generateProactive(env, now, decision, scene, moodToneHint(mood));
  if ('error' in generated) {
    await releaseSlot(env, dateKey, slotKey);
    return { error: generated.error, kind };
  }

  const saved = await insertProactiveMessage(env, generated.text, kind, now);
  if (generated.cost > 0 || generated.promptTokens > 0) {
    await updateMessageUsage(env, saved.id, {
      cost: generated.cost,
      promptTokens: generated.promptTokens,
      completionTokens: generated.completionTokens,
    });
  }
  // ★ 推送到 QQ：直连 AstrBot 或入队供客户端轮询（携带 message_id 便于追踪）
  const delivery = await deliverProactive(env, generated.text, now, saved.id);
  await finishSlot(env, dateKey, slotKey, {
    messageId: saved.id,
    // ★ 队列模式记 'queued'：入队≠送达，真正的送达要等插件 ack
    status: delivery.status,
    detail: `score=${decision.score}; delivery=${delivery.mode}; ${decision.reasons.join('; ')}`,
  });
  return {
    sent: true,
    message: generated.text,
    kind,
    score: decision.score,
    reasons: decision.reasons,
  };
}

/** 早晚固定时段（morning / evening）。 */
/** 用户 /退订 后写入的暂停截止时间。 */
const PAUSE_KEY = 'proactive:paused_until';

export async function isPaused(env: Env, now: Date): Promise<boolean> {
  const raw = await env.KV.get(PAUSE_KEY).catch(() => null);
  if (!raw) return false;
  const until = Date.parse(raw);
  return Number.isFinite(until) && now.getTime() < until;
}

/**
 * 诊断：跑一遍决策，但不发送、不写 proactive_log。
 *
 * 主动消息「没发」时最需要知道的就是这句 skipped 的 reason，
 * 而正常路径把结果丢在 waitUntil 里，日志里看不到。
 */
export interface ProactiveDiagnosis {
  dateKey: string;
  minutes: number;
  inWindow: string | null;
  windowTargets: { morning: number; evening: number };
  paused: boolean;
  level: string;
  mood: { mood: string; intensity: number; suggestContact: boolean; signals: string[] };
  feedbackMultiplier: number;
  profile: {
    minutesSinceLastUserMsg: number | null;
    minutesSinceLastProactive: number | null;
    repliesAfterLastProactive: number | null;
    hourlyActivity: number[];
  };
  decision: Decision;
  claimedToday: string[];
}

export async function diagnoseProactive(env: Env, now: Date): Promise<ProactiveDiagnosis> {
  const dateKey = dateKeyInBeijing(now);
  const minutes = beijingMinutes(now);
  const slot = currentSlot(minutes);

  const claimed = await env.DB.prepare('SELECT slot_key FROM proactive_log WHERE date_key = ?')
    .bind(dateKey)
    .all<{ slot_key: string }>()
    .catch(() => ({ results: [] as { slot_key: string }[] }));

  const [profile, dayCtx, memory] = await Promise.all([
    collectUserProfile(env, now),
    getOrCreateDayContext(env, dateKey),
    getMemory(env),
  ]);
  const environment = await collectEnvironment(env, now, dayCtx);
  const pendingTopics = extractPendingTopics(memory, now);
  const level = (env.PROACTIVE_LEVEL as 'quiet' | 'normal' | 'active') || 'normal';

  const recentUserMsgs = await env.DB.prepare(
    `SELECT content FROM messages WHERE role = 'user' ORDER BY id DESC LIMIT 6`,
  ).all<{ content: string }>();
  const moodText = (recentUserMsgs.results ?? []).map((r) => r.content).join('\n');
  const mood = await analyzeMoodSmart(env, moodText).catch(() => analyzeMood(moodText));

  const [firstChatDate, streakDays] = await Promise.all([
    getFirstChatDate(env),
    computeStreak(env, dateKey),
  ]);
  const milestones = detectMilestones({
    firstChatDate,
    today: dateKey,
    streakDays,
    memoryEntryCount: countMemoryEntries(memory),
  });

  const fbStats = await getFeedbackStats(env, 30).catch(() => null);
  const feedbackMultiplier = fbStats ? feedbackCooldownMultiplier(fbStats) : 1;

  const decision = decideProactive({
    profile,
    env: environment,
    pendingTopics,
    level,
    mood,
    milestones,
    feedbackMultiplier,
    slot: slot ?? 'random',
  });

  return {
    dateKey,
    minutes,
    inWindow: slot,
    windowTargets: {
      morning: targetMinutesFor(dateKey, 'morning'),
      evening: targetMinutesFor(dateKey, 'evening'),
    },
    paused: await isPaused(env, now),
    level,
    mood: {
      mood: mood.mood,
      intensity: mood.intensity,
      suggestContact: mood.suggestContact,
      signals: mood.signals,
    },
    feedbackMultiplier,
    profile: {
      minutesSinceLastUserMsg: profile.minutesSinceLastUserMsg,
      minutesSinceLastProactive: profile.minutesSinceLastProactive,
      repliesAfterLastProactive: profile.repliesAfterLastProactive,
      hourlyActivity: profile.hourlyActivity ?? [],
    },
    decision,
    claimedToday: (claimed.results ?? []).map((r) => r.slot_key),
  };
}

/** 超过这么久没心跳才提醒（客户端 5 分钟一次）。 */
export const OFFLINE_ALERT_HOURS = 3;

export type OfflineCheckResult =
  | 'no-heartbeat'
  | 'online'
  | 'already-alerted'
  | 'alerted'
  | 'enqueue-failed';

/**
 * QQ 通道掉线检查（由 cron 每 5 分钟调用一次）。
 *
 * 手机被 Android 杀掉后客户端会静默消失，只能从事后心跳看出来；
 * 这里把它变成一条能送到你眼前的消息：入队一条运维提醒。
 * 如果客户端确实已经死了，没人会拉这条队列——它会自然过期，不会污染记忆。
 */
export async function checkChannelOffline(env: Env, now: Date): Promise<OfflineCheckResult> {
  const hb = await getHeartbeat(env);
  if (!hb) return 'no-heartbeat';

  const at = Date.parse(hb.at);
  if (!Number.isFinite(at)) return 'no-heartbeat';
  const hours = (now.getTime() - at) / 3600000;
  if (hours < OFFLINE_ALERT_HOURS) return 'online';

  const alertedAt = await getOfflineAlertedAt(env);
  if (alertedAt === hb.at) return 'already-alerted';

  const text =
    `⚠️ QQ 通道已经 ${Math.round(hours)} 小时没有心跳了，手机上的客户端可能被系统停掉。` +
    '重新打开 Termux、执行 bash ds.sh start 就能恢复。';
  const id = await enqueueProactive(env, text, now).catch(() => 0);
  if (!id) return 'enqueue-failed';

  await setOfflineAlertedAt(env, hb.at);
  return 'alerted';
}

export async function runWebProactiveSlot(env: Env, now: Date): Promise<ProactiveResult> {
  if (await isPaused(env, now)) return { skipped: '用户已暂停主动消息' };
  const dateKey = dateKeyInBeijing(now);
  const minutes = beijingMinutes(now);
  const slot = currentSlot(minutes);
  if (!slot) return { skipped: '不在固定时段窗口' };

  if (minutes < targetMinutesFor(dateKey, slot)) {
    return { skipped: '未到当天随机目标时间' };
  }
  return emit(env, now, dateKey, slot, slot, PROACTIVE_WINDOWS[slot].name);
}

/** 手动触发一次固定时段主动消息（调试 / 补偿用，不检查时间窗口）。 */
export async function runProactiveNow(
  env: Env,
  now: Date,
  kind: 'morning' | 'evening' = 'evening',
): Promise<ProactiveResult> {
  const dateKey = dateKeyInBeijing(now);
  return emit(env, now, dateKey, kind, kind, kind === 'evening' ? '睡前' : '早安');
}

/** 白天随机主动消息（0~2 条，仍受打分约束）。 */
export async function runWebProactiveRandom(env: Env, now: Date): Promise<ProactiveResult> {
  if (await isPaused(env, now)) return { skipped: '用户已暂停主动消息' };
  const dateKey = dateKeyInBeijing(now);
  const minutes = beijingMinutes(now);
  if (minutes < RANDOM_WINDOW.start || minutes >= RANDOM_WINDOW.end) {
    return { skipped: '不在随机窗口' };
  }

  const total = randomCountFor(dateKey);
  if (total === 0) return { skipped: '今天随机决定不发' };

  for (let i = 0; i < total; i++) {
    const target = randomTargetMinutes(dateKey, i);
    if (target >= RANDOM_WINDOW.end) continue;
    if (minutes < target) continue;

    const slotKey = `random-${i}`;
    const exists = await env.DB.prepare(
      'SELECT 1 AS x FROM proactive_log WHERE date_key = ? AND slot_key = ?',
    )
      .bind(dateKey, slotKey)
      .first<{ x: number }>();
    if (exists) continue;

    const hour = Math.floor(minutes / 60);
    const scene = hour < 11 ? '上午' : hour < 14 ? '中午' : hour < 18 ? '下午' : hour < 21 ? '傍晚' : '晚上';
    return emit(env, now, dateKey, slotKey, 'random', scene);
  }
  return { skipped: '今天的随机消息已全部发送或未到点' };
}
