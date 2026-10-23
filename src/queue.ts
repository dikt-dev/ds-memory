/**
 * 主动消息队列（方案 B：反向轮询）。
 * Worker 生成消息后入队；AstrBot 插件定时拉取并在本地发送，发送成功后 ack。
 * 表：proactive_queue（D1）
 */
import type { Env } from './types';
import { isoInBeijing } from './date';

export interface QueuedMessage {
  id: number;
  content: string;
  created_at: string;
}

/** 入队一条主动消息（messageId 关联 messages.id，便于追溯）。 */
export async function enqueueProactive(
  env: Env,
  content: string,
  at: Date = new Date(),
  messageId?: number,
): Promise<number> {
  const row = await env.DB.prepare(
    'INSERT INTO proactive_queue (content, created_at, message_id) VALUES (?, ?, ?) RETURNING id',
  )
    .bind(content, isoInBeijing(at), messageId ?? null)
    .first<{ id: number }>();
  return row?.id ?? 0;
}

/** 取待发送消息（未发送且未超过最大尝试次数，按时间正序）。 */
export async function takePending(env: Env, limit = 5): Promise<QueuedMessage[]> {
  const rows = await env.DB.prepare(
    `SELECT id, content, created_at FROM proactive_queue
     WHERE sent_at IS NULL AND attempts < 5
     ORDER BY id ASC LIMIT ?`,
  )
    .bind(limit)
    .all<QueuedMessage>();
  return rows.results ?? [];
}

/** 标记已发送（ack）。 */
export async function ackSent(env: Env, ids: number[]): Promise<number> {
  if (ids.length === 0) return 0;
  const placeholders = ids.map(() => '?').join(',');
  const res = await env.DB.prepare(
    `UPDATE proactive_queue SET sent_at = ? WHERE id IN (${placeholders}) AND sent_at IS NULL`,
  )
    .bind(isoInBeijing(), ...ids)
    .run();
  return res.meta.changes ?? 0;
}

/** 记录一次失败尝试（避免坏消息无限重试）。 */
export async function markAttempt(env: Env, ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(',');
  await env.DB.prepare(
    `UPDATE proactive_queue SET attempts = attempts + 1 WHERE id IN (${placeholders})`,
  )
    .bind(...ids)
    .run();
}

/** 队列统计（供 stats 接口使用）。 */
export async function queueStats(env: Env): Promise<{ pending: number; sent: number; failed: number }> {
  const row = await env.DB.prepare(
    `SELECT
       SUM(CASE WHEN sent_at IS NULL AND attempts < 5 THEN 1 ELSE 0 END) AS pending,
       SUM(CASE WHEN sent_at IS NOT NULL THEN 1 ELSE 0 END) AS sent,
       SUM(CASE WHEN sent_at IS NULL AND attempts >= 5 THEN 1 ELSE 0 END) AS failed
     FROM proactive_queue`,
  ).first<{ pending: number | null; sent: number | null; failed: number | null }>();
  return { pending: row?.pending ?? 0, sent: row?.sent ?? 0, failed: row?.failed ?? 0 };
}

/** 清理 30 天前的已发送记录。 */
export async function cleanupQueue(env: Env): Promise<number> {
  const res = await env.DB.prepare(
    `DELETE FROM proactive_queue WHERE sent_at IS NOT NULL AND sent_at < datetime('now', '-30 days')`,
  ).run();
  return res.meta.changes ?? 0;
}
