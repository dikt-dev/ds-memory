/**
 * 主动消息质量反馈。
 *
 * 核心问题：主动消息发出后，用户有没有回？回得快不快？
 * 这决定了：
 * - 下次要不要用类似的语气/话题
 * - 冷却时间要不要拉长
 * - 哪个时段/哪类事由更受欢迎
 *
 * 实现：每条主动消息在 proactive_log 里记录，之后由定时任务回填反馈。
 */
import type { Env } from './types';

export interface FeedbackStats {
  /** 统计窗口内主动消息总数 */
  total: number;
  /** 得到回复的数量 */
  replied: number;
  /** 回复率 0~1 */
  replyRate: number;
  /** 平均回复耗时（分钟），null = 无数据 */
  avgReplyMinutes: number | null;
  /** 按时段统计的回复率（0-23 小时） */
  hourlyReplyRate: Array<{ hour: number; total: number; replied: number }>;
  /** 按类型统计 */
  byKind: Array<{ kind: string; total: number; replied: number; rate: number }>;
}

/**
 * 回填反馈：找出「已发送但还没回填反馈」的主动消息，
 * 检查其后 2 小时内用户是否发了消息。
 */
export async function backfillFeedback(env: Env, now: Date): Promise<number> {
  // 取最近 7 天、未回填反馈、且已超过 2 小时的消息
  const cutoffMs = now.getTime() - 2 * 60 * 60 * 1000;
  const rows = await env.DB.prepare(
    `SELECT m.id, m.created_ms, m.proactive_kind, m.date_key,
            (SELECT COUNT(*) FROM proactive_queue q WHERE q.message_id = m.id) AS queued,
            (SELECT COUNT(*) FROM proactive_queue q WHERE q.message_id = m.id AND q.sent_at IS NOT NULL) AS delivered
     FROM messages m
     LEFT JOIN proactive_feedback f ON f.message_id = m.id
     WHERE m.turn_type = 'proactive'
       AND m.created_ms <= ?
       AND m.created_ms >= ?
       AND f.id IS NULL
     ORDER BY m.id ASC
     LIMIT 50`,
  )
    .bind(cutoffMs, now.getTime() - 7 * 86400000)
    .all<{
      id: number;
      created_ms: number;
      proactive_kind: string | null;
      date_key: string;
      queued: number | null;
      delivered: number | null;
    }>();

  let filled = 0;
  for (const row of rows.results ?? []) {
    // ★ 队列模式却没送达的不能算「用户没回」：那条消息用户根本没看到。
    //   先跳过，等真送达了再评估（超过 7 天自然滑出窗口）。
    if ((row.queued ?? 0) > 0 && (row.delivered ?? 0) === 0) continue;
    // 该消息之后 2 小时内，用户有没有发消息
    const next = await env.DB.prepare(
      `SELECT created_ms FROM messages
       WHERE role = 'user' AND created_ms > ? AND created_ms <= ?
       ORDER BY created_ms ASC LIMIT 1`,
    )
      .bind(row.created_ms, row.created_ms + 2 * 60 * 60 * 1000)
      .first<{ created_ms: number }>();

    const replied = next !== null && next !== undefined;
    const replyMs = replied ? next.created_ms - row.created_ms : null;

    await env.DB.prepare(
      `INSERT INTO proactive_feedback (message_id, replied, reply_after_ms, kind, date_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        row.id,
        replied ? 1 : 0,
        replyMs,
        row.proactive_kind ?? 'unknown',
        row.date_key,
        new Date().toISOString(),
      )
      .run()
      .catch(() => {});
    filled += 1;
  }
  return filled;
}

/** 读取反馈统计（供决策引擎与统计接口使用）。 */
export async function getFeedbackStats(env: Env, days = 30): Promise<FeedbackStats> {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const rows = await env.DB.prepare(
    `SELECT f.replied, f.reply_after_ms, f.kind, f.date_key
     FROM proactive_feedback f
     WHERE f.created_at >= ?`,
  )
    .bind(since)
    .all<{ replied: number; reply_after_ms: number | null; kind: string; date_key: string }>();

  const list = rows.results ?? [];
  const total = list.length;
  const replied = list.filter((r) => r.replied === 1).length;
  const replyTimes = list.filter((r) => r.replied === 1 && r.reply_after_ms !== null).map((r) => r.reply_after_ms!);
  const avgReplyMinutes =
    replyTimes.length > 0 ? replyTimes.reduce((s, n) => s + n, 0) / replyTimes.length / 60000 : null;

  // 按 kind 聚合
  const byKindMap = new Map<string, { total: number; replied: number }>();
  for (const r of list) {
    const cur = byKindMap.get(r.kind) ?? { total: 0, replied: 0 };
    cur.total += 1;
    if (r.replied === 1) cur.replied += 1;
    byKindMap.set(r.kind, cur);
  }
  const byKind = [...byKindMap.entries()].map(([kind, v]) => ({
    kind,
    total: v.total,
    replied: v.replied,
    rate: v.total > 0 ? v.replied / v.total : 0,
  }));

  return {
    total,
    replied,
    replyRate: total > 0 ? replied / total : 0,
    avgReplyMinutes,
    hourlyReplyRate: [], // 需要 join messages 取小时，暂略
    byKind,
  };
}

/**
 * 根据历史反馈调整冷却时间。
 * 回复率低 → 拉长冷却（少打扰）；回复率高 → 可以正常甚至缩短。
 */
export function feedbackCooldownMultiplier(stats: FeedbackStats): number {
  if (stats.total < 5) return 1; // 样本太少不调整
  if (stats.replyRate >= 0.6) return 0.8; // 受欢迎，可以更主动
  if (stats.replyRate >= 0.3) return 1; // 正常
  if (stats.replyRate >= 0.15) return 1.5; // 不太受欢迎
  return 2.5; // 基本不回，大幅降低频率
}
