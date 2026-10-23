/**
 * 关系驱动所需的当日统计（从 D1 汇总）。
 *
 * 这些统计是「好感度 / 亲密度」独立计算的输入：
 * - 亲密度用「量」：当天消息轮次、累计有效聊天天数
 * - 好感度用「质」：当天用户消息文本 → scanQuality()
 */

import type { Env } from './types';
import { scanQuality, type AffinitySignals, type IntimacySignals, type QualityScan } from './relation-drivers';
import { getActiveDaysState, mergeActiveDays, setActiveDaysState } from './relation-store';
import { analyzeMood } from './mood';

/**
 * 当天用户情绪低落、但确实有陪伴（AI 有回复）。
 *
 * 语义：“陪伴低落情绪”应当算一份好感度正向信号。
 * 判定：用户当天多数消息情绪偏负面，且当天发生了一轮以上完整对话。
 *
 * @param userTexts 当天用户消息文本
 * @param hasAssistantReply 当天是否有助手回复（陪伴发生）
 */
export function detectLowMoodButCompanioned(
  userTexts: string[],
  hasAssistantReply: boolean,
): boolean {
  if (!hasAssistantReply || userTexts.length === 0) return false;
  // 只看有实质内容的消息，避免一条“嗯”拉偏整体
  const meaningful = userTexts.filter((t) => t && t.trim().length >= 2);
  if (meaningful.length === 0) return false;

  let negative = 0;
  for (const text of meaningful) {
    const r = analyzeMood(text);
    // 负向或者虽然中性但被识别为疲惫/忙碌，都算“状态不高”
    if (r.valence < -0.1 || r.mood === 'low' || r.mood === 'tired' || r.mood === 'busy') {
      negative += 1;
    }
  }
  // 半数以上消息偏负面 → 当天整体低落
  return negative * 2 >= meaningful.length;
}

/** 当天助手是否回复过（用于判断“陪伴”是否真的发生）。 */
export async function hasAssistantReplyOn(env: Env, dateKey: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM messages
     WHERE date_key = ? AND role = 'assistant' AND turn_type = 'chat'`,
  )
    .bind(dateKey)
    .first<{ c: number | null }>();
  return (row?.c ?? 0) > 0;
}

/** 累计有效聊天天数（有消息的不同日期数，仅 D1 当前可见范围）。
 *
 * ★ 这个值会因月度归档清理而**倒退**，不能直接当「历史累计天数」用。
 *   历史累计请用 resolveActiveDays（KV 持久化 + 与 D1 取最大值）。
 */
export async function countActiveDays(env: Env): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(DISTINCT date_key) AS c FROM messages`,
  ).first<{ c: number | null }>();
  return row?.c ?? 0;
}

/**
 * 取「历史累计有效聊天天数」，并把目标日期计入历史。
 *
 * D1 会被月度任务删掉 3 个月前数据，故取「KV 历史值」与「D1 现值」的较大者；
 * 并行的 mergeActiveDays 会为新出现的日期 +1。
 */
export async function resolveActiveDays(env: Env, forDate: string): Promise<number> {
  const [stored, d1Days] = await Promise.all([getActiveDaysState(env), countActiveDays(env)]);
  const merged = mergeActiveDays(stored, d1Days, forDate);
  if (merged.advanced || merged.state.days !== stored.days || merged.state.lastDate !== stored.lastDate) {
    await setActiveDaysState(env, merged.state);
  }
  return merged.effective;
}

/** 当天用户消息条数与文本。 */
export async function getDayUserMessages(
  env: Env,
  dateKey: string,
): Promise<{ count: number; texts: string[] }> {
  const rows = await env.DB.prepare(
    `SELECT content FROM messages WHERE role = 'user' AND date_key = ? ORDER BY id ASC`,
  )
    .bind(dateKey)
    .all<{ content: string }>();
  const texts = (rows.results ?? []).map((r) => r.content);
  return { count: texts.length, texts };
}

/** 当天用户是否完全没有回应（有主动消息但没有用户消息）。 */
export async function wasUserSilent(
  env: Env,
  dateKey: string,
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT
       SUM(CASE WHEN role = 'user' THEN 1 ELSE 0 END) AS user_count,
       SUM(CASE WHEN turn_type = 'proactive' THEN 1 ELSE 0 END) AS proactive_count
     FROM messages WHERE date_key = ?`,
  )
    .bind(dateKey)
    .first<{ user_count: number | null; proactive_count: number | null }>();
  const userCount = row?.user_count ?? 0;
  const proactiveCount = row?.proactive_count ?? 0;
  return proactiveCount > 0 && userCount === 0;
}

export interface DayRelationStats {
  /** 亲密度输入（完整） */
  intimacy: IntimacySignals;
  /** 好感度输入（完整） */
  affinity: AffinitySignals;
  /** 质量扫描明细（调试用） */
  quality: QualityScan;
}

/**
 * 收集当天的关系驱动统计。
 * streakDays 与 daysSinceInteraction 由调用方传入（已从 milestone 取好）。
 */
export async function collectDayRelationStats(
  env: Env,
  dateKey: string,
  newMemoryEntries: number,
  opts: { streakDays: number; daysSinceInteraction: number },
): Promise<DayRelationStats> {
  // ★ 用历史累计天数（KV 持久化），而不是 D1 现值：后者会被月度归档清理而倒退
  const [{ count: userMessages, texts }, activeDays, userSilent, hasReply] = await Promise.all([
    getDayUserMessages(env, dateKey),
    resolveActiveDays(env, dateKey),
    wasUserSilent(env, dateKey),
    hasAssistantReplyOn(env, dateKey),
  ]);

  const quality = scanQuality(texts);
  // ★ 真正计算“陪伴低落情绪”：之前这里写死 false，导致该信号永远不生效
  const lowMoodButCompanioned = detectLowMoodButCompanioned(texts, hasReply);

  return {
    intimacy: {
      userMessages,
      streakDays: opts.streakDays,
      newMemoryEntries,
      activeDays: Math.max(activeDays, 1),
      daysSinceInteraction: opts.daysSinceInteraction,
    },
    affinity: {
      warmTurns: quality.warmTurns,
      gratefulCount: quality.gratefulCount,
      offensiveCount: quality.offensiveCount,
      hadConflict: quality.hadConflict,
      lowMoodButCompanioned, // 由当天用户情绪 + 是否真有回复共同判定
      ignoredAllDay: userSilent,
    },
    quality,
  };
}
