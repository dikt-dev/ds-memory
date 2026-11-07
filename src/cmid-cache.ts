/**
 * 客户端消息去重缓存（原 app:cmid:* in KV）。
 *
 * 为什么挪到 D1：
 * - KV 免费版每天只有 1000 次写，手机上每发一条消息就要写一次，很容易打满；
 * - D1 每天 10 万行写，随便用；
 * - 读也是主键查询，比 KV 快不了多少但便宜。
 *
 * 语义不变：同一个 client_message_id 再来一次时直接回放上次的结果，不重复落库、不重复花模型钱。
 */
import type { Env } from './types';
import { logError } from './error-log';

export interface CachedTurn {
  content: string;
  user_message_id?: number;
  assistant_message_id?: number;
  created_at?: string;
}

/** 7 天没用就清掉（和原来 KV 的 expirationTtl 对齐）。 */
export const CMID_TTL_MS = 7 * 24 * 3600_000;

export async function getCachedTurn(env: Env, clientMessageId: string): Promise<CachedTurn | null> {
  if (!clientMessageId) return null;
  const row = await env.DB.prepare(
    'SELECT content, user_message_id, assistant_message_id, created_at FROM cmid_cache WHERE client_message_id = ?',
  )
    .bind(clientMessageId)
    .first<{ content: string; user_message_id: number | null; assistant_message_id: number | null; created_at: number }>()
    .catch(() => null);
  if (!row || !row.content) return null;
  if (Date.now() - Number(row.created_at) > CMID_TTL_MS) return null;
  return {
    content: row.content,
    user_message_id: row.user_message_id ?? undefined,
    assistant_message_id: row.assistant_message_id ?? undefined,
    created_at: new Date(Number(row.created_at)).toISOString(),
  };
}

export async function putCachedTurn(
  env: Env,
  clientMessageId: string,
  turn: CachedTurn,
): Promise<void> {
  if (!clientMessageId || !turn.content) return;
  await env.DB.prepare(
    `INSERT INTO cmid_cache (client_message_id, content, user_message_id, assistant_message_id, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(client_message_id) DO UPDATE SET
       content = excluded.content,
       user_message_id = excluded.user_message_id,
       assistant_message_id = excluded.assistant_message_id,
       created_at = excluded.created_at`,
  )
    .bind(
      clientMessageId,
      turn.content,
      turn.user_message_id ?? null,
      turn.assistant_message_id ?? null,
      Date.now(),
    )
    .run()
    .catch((e: unknown) => logError('[cmid] write failed:', e));
}

/** 定期清理过期行（每日归档调用）。 */
export async function pruneCmidCache(env: Env): Promise<number> {
  const cutoff = Date.now() - CMID_TTL_MS;
  const res = await env.DB.prepare('DELETE FROM cmid_cache WHERE created_at < ?')
    .bind(cutoff)
    .run()
    .catch(() => null);
  return Number((res as { meta?: { changes?: number } } | null)?.meta?.changes ?? 0);
}
