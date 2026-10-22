/**
 * 关系驱动所需的当日统计（从 D1 汇总）。
 *
 * 这些统计是「好感度 / 亲密度」独立计算的输入：
 * - 亲密度用「量」：当天消息轮次、累计有效聊天天数
 * - 好感度用「质」：当天用户消息文本 → scanQuality()
 */

import type { Env } from './types';
import { scanQuality, type AffinitySignals, type IntimacySignals, type QualityScan } from './relation-drivers';

/** 累计有效聊天天数（有消息的不同日期数）。 */
export async function countActiveDays(env: Env): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(DISTINCT date_key) AS c FROM messages`,
  ).first<{ c: number | null }>();
  return row?.c ?? 0;
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
  const [{ count: userMessages, texts }, activeDays, userSilent] = await Promise.all([
    getDayUserMessages(env, dateKey),
    countActiveDays(env),
    wasUserSilent(env, dateKey),
  ]);

  const quality = scanQuality(texts);

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
      lowMoodButCompanioned: false, // 由调用方结合 mood 判断
      ignoredAllDay: userSilent,
    },
    quality,
  };
}
