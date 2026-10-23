/**
 * 主动消息队列（方案 B：反向轮询）。
 * Worker 生成消息后入队；AstrBot 插件定时拉取并在本地发送，发送成功后 ack。
 * 表：proactive_queue（D1）
 *
 * ★ 时间格式约定（重要）：`created_at` / `sent_at` 一律用 `isoInBeijing()`，
 *   形如 `2026-10-23T10:49:00+08:00`。**不要**用 SQLite 的 `datetime('now')`
 *   与之比较——它产出 `2026-10-23 02:49:00`（空格分隔、UTC），
 *   字符串比较时第 11 个字符 `'T'(0x54) > ' '(0x20)`，
 *   会让「某时间之前」的条件永远不成立。需要比较时在 JS 里算好阈值再传参。
 */
import type { Env } from './types';
import { isoInBeijing } from './date';

export interface QueuedMessage {
  id: number;
  content: string;
  created_at: string;
}

/** 单条消息最多被尝试投递的次数（配合下面的时间窗口一起判断）。 */
export const MAX_ATTEMPTS = 8;

/** 投递失败后仍可重试的时间窗口（小时）。超过则视为过期，不再下发。 */
export const RETRY_WINDOW_HOURS = 6;

/** 占位租约：取出后若长时间没有 ack/nack，视为插件挂了，允许被重新拉取。 */
export const LEASE_SECONDS = 180;

/** 已发送记录的保留天数。 */
export const SENT_RETENTION_DAYS = 30;

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

/**
 * 取待发送消息，并**原子占位**。
 *
 * ★ 为什么必须占位：只 SELECT 不标记时，两个插件实例（或「手动推送」与
 *   轮询任务并发）会拿到同一批消息，导致用户收到重复内容。
 *   这里用 UPDATE ... RETURNING 把待发明细标记成「已租出」，
 *   同一条消息在租约期内不会被第二个调用者取到。
 *
 * 租约到期（默认 180 秒）仍未 ack/nack 的消息会重新可被拉取，
 * 避免插件崩溃后消息永久卡死。
 */
export async function takePending(env: Env, limit = 5): Promise<QueuedMessage[]> {
  const now = new Date();
  const leaseCutoff = isoInBeijing(new Date(now.getTime() - LEASE_SECONDS * 1000));
  const retryCutoff = isoInBeijing(new Date(now.getTime() - RETRY_WINDOW_HOURS * 3600 * 1000));

  // 子查询先选出目标 id，再用 UPDATE...RETURNING 原子地打上租约。
  // 条件：未发送、未超次数、未过期、且当前没有被别的调用者租住。
  const rows = await env.DB.prepare(
    `UPDATE proactive_queue
        SET leased_at = ?
      WHERE id IN (
        SELECT id FROM proactive_queue
         WHERE sent_at IS NULL
           AND attempts < ?
           AND created_at > ?
           AND (leased_at IS NULL OR leased_at < ?)
         ORDER BY id ASC
         LIMIT ?
      )
      RETURNING id, content, created_at`,
  )
    .bind(isoInBeijing(now), MAX_ATTEMPTS, retryCutoff, leaseCutoff, limit)
    .all<QueuedMessage>();

  return rows.results ?? [];
}

/** 标记已发送（ack）。 */
export async function ackSent(env: Env, ids: number[]): Promise<number> {
  if (ids.length === 0) return 0;
  const placeholders = ids.map(() => '?').join(',');
  const res = await env.DB.prepare(
    `UPDATE proactive_queue
        SET sent_at = ?, leased_at = NULL
      WHERE id IN (${placeholders}) AND sent_at IS NULL`,
  )
    .bind(isoInBeijing(), ...ids)
    .run();
  return res.meta.changes ?? 0;
}

/** 记录一次失败尝试（避免坏消息无限重试）。释放租约以便下一轮重试。 */
export async function markAttempt(env: Env, ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(',');
  await env.DB.prepare(
    `UPDATE proactive_queue
        SET attempts = attempts + 1, leased_at = NULL
      WHERE id IN (${placeholders}) AND sent_at IS NULL`,
  )
    .bind(...ids)
    .run();
}

/** 队列统计（供 stats 接口使用）。 */
export async function queueStats(env: Env): Promise<{ pending: number; sent: number; failed: number }> {
  const now = new Date();
  const retryCutoff = isoInBeijing(new Date(now.getTime() - RETRY_WINDOW_HOURS * 3600 * 1000));
  const row = await env.DB.prepare(
    `SELECT
       SUM(CASE WHEN sent_at IS NULL AND attempts < ? AND created_at > ? THEN 1 ELSE 0 END) AS pending,
       SUM(CASE WHEN sent_at IS NOT NULL THEN 1 ELSE 0 END) AS sent,
       SUM(CASE WHEN sent_at IS NULL AND (attempts >= ? OR created_at <= ?) THEN 1 ELSE 0 END) AS failed
     FROM proactive_queue`,
  )
    .bind(MAX_ATTEMPTS, retryCutoff, MAX_ATTEMPTS, retryCutoff)
    .first<{ pending: number | null; sent: number | null; failed: number | null }>();
  return { pending: row?.pending ?? 0, sent: row?.sent ?? 0, failed: row?.failed ?? 0 };
}

/**
 * 清理过期记录：已发送且超过保留期的，以及早就过期也没必要再试的。
 *
 * ★ 历史 bug：原来写 `sent_at < datetime('now', '-30 days')`，
 *   而 sent_at 是带 `T` 和 `+08:00` 的 ISO 字符串，字符串比较永远不成立
 *   （`'T'` > `' '`），导致表无限增长。现在改为在 JS 里算好阈值再传参。
 */
export async function cleanupQueue(env: Env): Promise<number> {
  const now = new Date();
  const sentCutoff = isoInBeijing(new Date(now.getTime() - SENT_RETENTION_DAYS * 86400 * 1000));
  const retryCutoff = isoInBeijing(new Date(now.getTime() - RETRY_WINDOW_HOURS * 3600 * 1000));

  const res = await env.DB.prepare(
    `DELETE FROM proactive_queue
      WHERE (sent_at IS NOT NULL AND sent_at < ?)
         OR (sent_at IS NULL AND (attempts >= ? OR created_at <= ?))`,
  )
    .bind(sentCutoff, MAX_ATTEMPTS, retryCutoff)
    .run();
  return res.meta.changes ?? 0;
}
