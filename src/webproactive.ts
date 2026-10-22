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
import { getOrCreateDayContext } from './context';
import { getTodaySummary } from './summary';
import { recentMessages, recentProactiveMessages, insertProactiveMessage, updateMessageUsage } from './db';
import { parseRelationValues } from './memory-maintenance';
import { describeAttitude } from './attitude';
import { completeDeepSeek } from './deepseek';
import {
  decideProactive,
  extractPendingTopics,
  type Decision,
  type EnvironmentSignal,
  type UserProfile,
} from './proactive-engine';
import { getCachedProfile, setCachedProfile } from './profile-cache';
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
import { getSessionMood, sessionMoodNote } from './session-state';
import { formatRecentMemoBlock, getRecentMemo } from './recent-memory';
import { recallForQuery } from './memory-archive';
import { computeMoodDrift } from './mood-env';
import { readSessionFacts } from './session-facts';

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
async function collectEnvironment(env: Env, now: Date, dayCtx: { is_holiday: boolean }): Promise<EnvironmentSignal> {
  const dateKey = dateKeyInBeijing(now);
  const minutes = beijingMinutes(now);
  const hour = Math.floor(minutes / 60);

  // 天气变化：对比当天 context 里已记录的天气与当前实时天气
  let weatherChanged = false;
  try {
    const current = await getOrCreateDayContext(env, dateKey);
    const live = await fetchWeather(env);
    if (current.weather && live) {
      const tempDiff = Math.abs(current.weather.temp_c - live.temp_c);
      const descDiff = current.weather.desc !== live.desc;
      weatherChanged = tempDiff >= 6 || descDiff;
    }
  } catch {
    /* 忽略 */
  }

  // 特殊日期：节假日当天（不含普通周末）
  const isSpecialDay = dayCtx.is_holiday && !/^周末$/.test(dateKey) ? false : false;
  // 简化：节假日标记由 holiday_note 判断
  const ctx = await getOrCreateDayContext(env, dateKey);
  const special = ctx.is_holiday && ctx.holiday_note !== '周末';

  return { hour, isRestDay: ctx.is_holiday, weatherChanged, isSpecialDay: special || isSpecialDay };
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
  const [memory, weather, dayCtx, todaySummaryRaw, history, recentProactive] = await Promise.all([
    getMemory(env),
    fetchWeather(env),
    getOrCreateDayContext(env, dateKey),
    getTodaySummary(env, dateKey),
    recentMessages(env, 12),
    recentProactiveMessages(env, 6),
  ]);
  const relation = parseRelationValues(memory);
  // 中期记忆优先：它存在时跳过今日摘要，避免重复
  const recentMemo = formatRecentMemoBlock(await getRecentMemo(env));
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
  const envDrift = computeMoodDrift({
    hour: hourNow,
    isRestDay: dayCtx.is_holiday,
    weather,
    month: Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', month: '2-digit' }).format(now)),
  });
  const sessionMood = await getSessionMood(env, now.getTime());
  const effectiveMood = Math.min(1000, Math.max(0, relation.mood + envDrift.delta + sessionMood.offset));
  const facts = await readSessionFacts(env, now, dateKey);
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
  const moodNote = sessionMoodNote(sessionMood);
  const cardText = moodNote ? `${charCard.cardText}\n- 情绪残留：${moodNote}` : charCard.cardText;
  // 主动消息也带上相关往事：用最近几条对话当检索词
  const recalled = await recallForQuery(
    env,
    history
      .slice(-4)
      .map((m) => m.content)
      .join(' '),
  );

  const systemPrompt = buildBaseSystemPrompt({
    now,
    ctx,
    memory,
    weather,
    todaySummary,
    recentMemo,
    recalled,
    channel: 'web',
    characterCard: cardText,
    voice: buildVoiceDirective(relation.intimacy),
    attitude: describeAttitude(relation.affinity, relation.intimacy, effectiveMood),
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
  opts: { messageId?: number; status: 'sent' | 'failed'; detail?: string },
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
  // ★ 推送到 QQ：直连 AstrBot 或入队供插件轮询（携带 message_id 便于追踪）
  const delivery = await deliverProactive(env, generated.text, now, saved.id);
  await finishSlot(env, dateKey, slotKey, {
    messageId: saved.id,
    status: delivery.ok ? 'sent' : 'failed',
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
export async function runWebProactiveSlot(env: Env, now: Date): Promise<ProactiveResult> {
  const dateKey = dateKeyInBeijing(now);
  const minutes = beijingMinutes(now);
  const slot = currentSlot(minutes);
  if (!slot) return { skipped: '不在固定时段窗口' };

  if (minutes < targetMinutesFor(dateKey, slot)) {
    return { skipped: '未到当天随机目标时间' };
  }
  return emit(env, now, dateKey, slot, slot, PROACTIVE_WINDOWS[slot].name);
}

/** 白天随机主动消息（0~2 条，仍受打分约束）。 */
export async function runWebProactiveRandom(env: Env, now: Date): Promise<ProactiveResult> {
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
