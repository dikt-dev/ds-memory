/**
 * 运行时状态存储（Phase 1：把高频 KV 状态迁到 D1）。
 *
 * 设计：
 * - 首选 D1 `runtime_state(key, value, updated_at, expires_at)`；
 * - D1 不可用/表不存在时回退 KV，保证本地测试与灰度安全；
 * - 锁使用 D1 原子 UPSERT，避免两个请求同时生成摘要；
 * - 所有值都是字符串，复杂对象由调用方 JSON 序列化。
 */
import type { Env } from './types';
import { recordDegradation } from './degradations';

const TABLE = 'runtime_state';

function hasDb(env: Env): boolean {
  return Boolean(env.DB && typeof env.DB.prepare === 'function');
}

function nowMs(): number {
  return Date.now();
}

/** 读取一个运行时状态；过期视为不存在。D1 失败时回退 KV。 */
export async function getRuntimeState(env: Env, key: string): Promise<string | null> {
  if (hasDb(env)) {
    try {
      const row = await env.DB.prepare(
        `SELECT value FROM ${TABLE}
         WHERE key = ? AND (expires_at IS NULL OR expires_at > ?)`,
      )
        .bind(key, nowMs())
        .first<{ value: string }>();
      if (row && typeof row.value === 'string') return row.value;
      if (row === null) return null;
    } catch {
      // 表未迁移/本地假 DB：回退 KV
    }
  }
  return env.KV.get(key).catch(() => {
    void recordDegradation(env, 'kv_read');
    return null;
  });
}

/** 写入运行时状态；ttlSeconds 为空表示不过期。D1 失败时回退 KV。 */
export async function putRuntimeState(
  env: Env,
  key: string,
  value: string,
  ttlSeconds?: number,
): Promise<void> {
  const now = nowMs();
  const expiresAt = ttlSeconds && ttlSeconds > 0 ? now + ttlSeconds * 1000 : null;
  if (hasDb(env)) {
    try {
      await env.DB.prepare(
        `INSERT INTO ${TABLE} (key, value, updated_at, expires_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at,
           expires_at = excluded.expires_at`,
      )
        .bind(key, value, now, expiresAt)
        .run();
      return;
    } catch {
      // 回退 KV
    }
  }
  await env.KV.put(key, value, ttlSeconds && ttlSeconds > 0 ? { expirationTtl: ttlSeconds } : undefined).catch(
    () => {},
  );
}

export async function deleteRuntimeState(env: Env, key: string): Promise<void> {
  if (hasDb(env)) {
    try {
      await env.DB.prepare(`DELETE FROM ${TABLE} WHERE key = ?`).bind(key).run();
      return;
    } catch {
      // 回退 KV
    }
  }
  await env.KV.delete(key).catch(() => {});
}

/**
 * 获取一个短锁。
 * 返回 true = 抢到；false = 已有未过期锁。
 * D1 用原子 UPSERT；无 D1 时回退 KV 的 get+put（单 isolate 测试够用）。
 */
export async function acquireRuntimeLock(env: Env, key: string, ttlSeconds: number): Promise<boolean> {
  const now = nowMs();
  const expiresAt = now + Math.max(1, ttlSeconds) * 1000;
  if (hasDb(env)) {
    try {
      const row = await env.DB.prepare(
        `INSERT INTO ${TABLE} (key, value, updated_at, expires_at)
         VALUES (?, '1', ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value = '1',
           updated_at = excluded.updated_at,
           expires_at = excluded.expires_at
         WHERE ${TABLE}.expires_at IS NULL OR ${TABLE}.expires_at < ?
         RETURNING key`,
      )
        .bind(key, now, expiresAt, now)
        .first<{ key: string }>();
      return Boolean(row?.key);
    } catch {
      // 回退 KV
    }
  }
  const existing = await env.KV.get(key).catch(() => null);
  if (existing) return false;
  await env.KV.put(key, '1', { expirationTtl: Math.max(1, ttlSeconds) }).catch(() => {});
  return true;
}

export async function releaseRuntimeLock(env: Env, key: string): Promise<void> {
  await deleteRuntimeState(env, key);
}

/** 清理过期行；建议每日归档时调用一次。 */
export async function cleanupRuntimeState(env: Env, now = nowMs()): Promise<number> {
  if (!hasDb(env)) return 0;
  try {
    const res = await env.DB.prepare(
      `DELETE FROM ${TABLE} WHERE expires_at IS NOT NULL AND expires_at <= ?`,
    )
      .bind(now)
      .run();
    return res.meta.changes ?? 0;
  } catch {
    return 0;
  }
}
