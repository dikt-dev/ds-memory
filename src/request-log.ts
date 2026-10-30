import type { Env } from './types';

/**
 * 请求级 trace 落 D1。
 *
 * 为什么不是 Logpush / wrangler tail：这条网络连不上 `wrangler tail`
 * （到 173.231.12.107:443 超时），线上日志等于没有。而"改了看不见"是这个项目
 * 历史上所有翻车的共同原因（2026-10-29~31 三次）。所以把 trace 写进能 SQL 查的地方。
 *
 * 三条约束：
 * 1. **只记元信息**：路径、状态、耗时、渠道、计数；绝不写消息正文/记忆内容/密钥；
 * 2. **写失败静默**：trace 坏掉不能影响聊天（和 memory/emotion 的降级原则一致）；
 * 3. **有开关**：`REQUEST_LOG=off` 可整体关掉；默认开。
 */

const TABLE = 'request_log';
/** 保留天数：够回答"这周哪里慢"，又不会把 D1 撑大。 */
export const REQUEST_LOG_KEEP_DAYS = 30;

let ensured = false;

/** 测试用：重置建表缓存。 */
export function resetRequestLogCache(): void {
  ensured = false;
}

export interface RequestLogEntry {
  requestId: string;
  kind: 'http' | 'cron' | 'chat';
  path: string;
  ms: number;
  method?: string;
  status?: number;
  channel?: string;
  ok?: boolean;
  /** 短的 JSON 串（只在 kind='chat' 等场景用），超过 500 字会被截断 */
  detail?: string;
}

export interface RequestLogRow {
  at: number;
  request_id: string;
  kind: string;
  method: string | null;
  path: string;
  status: number | null;
  ms: number;
  channel: string | null;
  ok: number | null;
  detail: string | null;
}

export interface PathStats {
  path: string;
  count: number;
  p50: number;
  p95: number;
  maxMs: number;
  errors: number;
}

function dayKey(ms: number): string {
  // 与 date.ts 保持一致的北京时区口径，但这里不引入依赖，避免循环 import。
  return new Date(ms + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function enabled(env: { REQUEST_LOG?: string }): boolean {
  return (env.REQUEST_LOG ?? '').trim().toLowerCase() !== 'off';
}

export async function ensureRequestLogTable(env: Env): Promise<void> {
  if (ensured) return;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS ${TABLE} (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       at INTEGER NOT NULL,
       day_key TEXT NOT NULL,
       request_id TEXT NOT NULL,
       kind TEXT NOT NULL,
       method TEXT,
       path TEXT NOT NULL,
       status INTEGER,
       ms INTEGER NOT NULL,
       channel TEXT,
       ok INTEGER,
       detail TEXT
     )`,
  ).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_request_log_at ON ${TABLE}(at)`).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_request_log_path ON ${TABLE}(path, at)`).run();
  ensured = true;
}

/** 写一条请求记录。**调用方负责 waitUntil**；这里吞掉所有异常。 */
export async function recordRequest(env: Env, entry: RequestLogEntry): Promise<void> {
  if (!enabled(env)) return;
  try {
    await ensureRequestLogTable(env);
    const at = Date.now();
    await env.DB.prepare(
      `INSERT INTO ${TABLE}
       (at, day_key, request_id, kind, method, path, status, ms, channel, ok, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        at,
        dayKey(at),
        entry.requestId,
        entry.kind,
        entry.method ?? null,
        entry.path,
        entry.status ?? null,
        Math.max(0, Math.round(entry.ms)),
        entry.channel ?? null,
        entry.ok === undefined ? null : entry.ok ? 1 : 0,
        entry.detail ? entry.detail.slice(0, 500) : null,
      )
      .run();
  } catch {
    // trace 不能反过来影响被观测的请求
  }
}

/** 清理过期记录（每日归档时调用）。 */
export async function pruneRequestLog(env: Env, keepDays = REQUEST_LOG_KEEP_DAYS): Promise<number> {
  try {
    await ensureRequestLogTable(env);
    const cutoff = Date.now() - Math.max(1, keepDays) * 86_400_000;
    const res = await env.DB.prepare(`DELETE FROM ${TABLE} WHERE at < ?`).bind(cutoff).run();
    return Number((res as { meta?: { changes?: number } })?.meta?.changes ?? 0);
  } catch {
    return 0;
  }
}

/** 最近 window 毫秒内的原始记录（新的在前）。 */
export async function readRecentRequests(env: Env, limit = 50): Promise<RequestLogRow[]> {
  try {
    await ensureRequestLogTable(env);
    const res = await env.DB.prepare(
      `SELECT at, request_id, kind, method, path, status, ms, channel, ok, detail
       FROM ${TABLE} ORDER BY at DESC LIMIT ?`,
    )
      .bind(Math.min(500, Math.max(1, limit)))
      .all<RequestLogRow>();
    return res.results ?? [];
  } catch {
    return [];
  }
}

/**
 * 按路径聚合：条数、p50、p95、最大耗时、错误数。
 *
 * 为什么不交给 SQL 算分位：D1 没有 percentile 函数；取窗口内最多 5000 行回来自己算，
 * 这个量级足够回答"哪里慢"，又不会把响应撑爆。
 */
export async function readPathStats(
  env: Env,
  opts: { windowMs?: number; now?: number; maxRows?: number } = {},
): Promise<PathStats[]> {
  const now = opts.now ?? Date.now();
  const windowMs = Math.max(60_000, opts.windowMs ?? 24 * 3600_000);
  const maxRows = Math.min(5000, Math.max(100, opts.maxRows ?? 5000));
  try {
    await ensureRequestLogTable(env);
    const res = await env.DB.prepare(
      `SELECT at, request_id, kind, method, path, status, ms, channel, ok, detail
       FROM ${TABLE} WHERE at >= ? ORDER BY at DESC LIMIT ?`,
    )
      .bind(now - windowMs, maxRows)
      .all<RequestLogRow>();
    const byPath = new Map<string, { ms: number[]; errors: number }>();
    for (const row of res.results ?? []) {
      const slot = byPath.get(row.path) ?? { ms: [], errors: 0 };
      slot.ms.push(Number(row.ms) || 0);
      if ((Number(row.status) || 0) >= 400 || row.ok === 0) slot.errors += 1;
      byPath.set(row.path, slot);
    }
    return [...byPath.entries()]
      .map(([path, slot]) => ({
        path,
        count: slot.ms.length,
        p50: percentile(slot.ms, 0.5),
        p95: percentile(slot.ms, 0.95),
        maxMs: Math.max(...slot.ms),
        errors: slot.errors,
      }))
      .sort((a, b) => b.count - a.count || b.p95 - a.p95);
  } catch {
    return [];
  }
}

/** 最近邻分位（p=0.5 → 中位数）。入参会被排序。 */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)));
  return Math.round(sorted[idx]);
}
