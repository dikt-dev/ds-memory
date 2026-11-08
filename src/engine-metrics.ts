/**
 * Phase 5 观察指标：按天聚合 memory/affect/proactive 的 shadow/next 行为。
 *
 * 只记录计数、字节、耗时；不记录 query/回复正文。
 * 写入失败静默；legacy 不写。
 */
import type { Env } from './types';
import { dateKeyInBeijing } from './date';

export type EngineMetricKind = 'memory' | 'affect' | 'proactive';

export interface EngineMetricInput {
  channel: string;
  kind: EngineMetricKind;
  mode: string;
  oldItems: number;
  newItems: number;
  oldBytes: number;
  newBytes: number;
  ms: number;
  now?: number;
}

export interface EngineMetricRow {
  day_key: string;
  channel: string;
  kind: EngineMetricKind;
  mode: string;
  requests: number;
  old_items: number;
  new_items: number;
  old_bytes: number;
  new_bytes: number;
  avg_ms: number;
}

export async function recordEngineMetric(env: Env, input: EngineMetricInput): Promise<void> {
  if (input.mode !== 'shadow' && input.mode !== 'next') return;
  const day = dateKeyInBeijing(new Date(input.now ?? Date.now()));
  try {
    await env.DB.prepare(
      `INSERT INTO engine_metrics
       (day_key, channel, kind, mode, requests, old_items, new_items,
        old_bytes, new_bytes, ms_sum, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(day_key, channel, kind, mode) DO UPDATE SET
         requests = requests + 1,
         old_items = old_items + excluded.old_items,
         new_items = new_items + excluded.new_items,
         old_bytes = old_bytes + excluded.old_bytes,
         new_bytes = new_bytes + excluded.new_bytes,
         ms_sum = ms_sum + excluded.ms_sum,
         updated_at = excluded.updated_at`,
    )
      .bind(
        day,
        input.channel,
        input.kind,
        input.mode,
        Math.max(0, Math.round(input.oldItems)),
        Math.max(0, Math.round(input.newItems)),
        Math.max(0, Math.round(input.oldBytes)),
        Math.max(0, Math.round(input.newBytes)),
        Math.max(0, Math.round(input.ms)),
        Date.now(),
      )
      .run();
  } catch {
    // 指标失败不影响聊天
  }
}

export async function readEngineMetrics(env: Env, days = 7): Promise<EngineMetricRow[]> {
  const now = new Date();
  const cutoff = dateKeyInBeijing(new Date(now.getTime() - Math.max(1, days - 1) * 86400000));
  try {
    const rows = await env.DB.prepare(
      `SELECT day_key, channel, kind, mode, requests, old_items, new_items,
              old_bytes, new_bytes, ms_sum
       FROM engine_metrics
       WHERE day_key >= ?
       ORDER BY day_key DESC, channel, kind, mode
       LIMIT 2000`,
    )
      .bind(cutoff)
      .all<{
        day_key: string;
        channel: string;
        kind: EngineMetricKind;
        mode: string;
        requests: number;
        old_items: number;
        new_items: number;
        old_bytes: number;
        new_bytes: number;
        ms_sum: number;
      }>();
    return (rows.results ?? []).map((r) => ({
      day_key: r.day_key,
      channel: r.channel,
      kind: r.kind,
      mode: r.mode,
      requests: r.requests,
      old_items: r.old_items,
      new_items: r.new_items,
      old_bytes: r.old_bytes,
      new_bytes: r.new_bytes,
      avg_ms: r.requests > 0 ? Math.round(r.ms_sum / r.requests) : 0,
    }));
  } catch {
    return [];
  }
}

/**
 * 请求路径上的 JS 耗时采样（免费版 10ms CPU 预算的观测点）。
 *
 * 只测「拼提示词」这类纯 JS 段：D1/KV 的等待算 wall time，不算 CPU，
 * 混进来会把结论带偏。mode = cpu_prompt / cpu_total。
 */
/**
 * 请求路径上的 JS 耗时采样（免费版 10ms CPU 预算的观测点）。
 *
 * ★ 单独一张表：以前写进 engine_metrics（kind='memory'、mode='cpu_prompt'），
 *   和「引擎对比」的行混在一起——ms 与 µs 混用、requests 口径不同，看板数字没法解释（2026-11-08）。
 *
 * 只测「拼提示词」这类纯 JS 段：D1/KV 的等待算 wall time，不算 CPU。
 */
export async function recordCpuSample(
  env: Env,
  channel: string,
  mode: string,
  ms: number,
  now = Date.now(),
): Promise<void> {
  const day = dateKeyInBeijing(new Date(now));
  try {
    await ensureCpuTable(env);
    await env.DB.prepare(
      `INSERT INTO engine_cpu (day_key, channel, mode, requests, us_sum, updated_at)
       VALUES (?, ?, ?, 1, ?, ?)
       ON CONFLICT(day_key, channel, mode) DO UPDATE SET
         requests = requests + 1,
         us_sum = us_sum + excluded.us_sum,
         updated_at = excluded.updated_at`,
    )
      // 存微秒：拼装只要几百微秒，用毫秒取整会全变成 0
      .bind(day, channel, mode, Math.max(0, Math.round(ms * 1000)), now)
      .run();
  } catch {
    // 指标失败不影响聊天
  }
}

let cpuTableEnsured = false;
/** 建表只做一次（isolate 内存标记）；DDL 失败不影响聊天。 */
async function ensureCpuTable(env: Env): Promise<void> {
  if (cpuTableEnsured) return;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS engine_cpu (
       day_key    TEXT NOT NULL,
       channel    TEXT NOT NULL,
       mode       TEXT NOT NULL,
       requests   INTEGER NOT NULL DEFAULT 0,
       us_sum     INTEGER NOT NULL DEFAULT 0,
       updated_at INTEGER NOT NULL,
       PRIMARY KEY (day_key, channel, mode)
     )`,
  ).run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_engine_cpu_day ON engine_cpu(day_key)').run();
  cpuTableEnsured = true;
}

export interface CpuSampleRow {
  day_key: string;
  channel: string;
  mode: string;
  requests: number;
  avgUs: number;
}

/** 读最近 N 天的 CPU 采样（管理端与排查用）。 */
export async function readCpuSamples(env: Env, days = 3): Promise<CpuSampleRow[]> {
  const cutoff = dateKeyInBeijing(new Date(Date.now() - Math.max(1, days - 1) * 86400000));
  try {
    await ensureCpuTable(env);
    const rows = await env.DB.prepare(
      `SELECT day_key, channel, mode, requests, us_sum
         FROM engine_cpu WHERE day_key >= ?
        ORDER BY day_key DESC, mode
        LIMIT 2000`,
    )
      .bind(cutoff)
      .all<{ day_key: string; channel: string; mode: string; requests: number; us_sum: number }>();
    return (rows.results ?? []).map((r) => ({
      day_key: r.day_key,
      channel: r.channel,
      mode: r.mode,
      requests: r.requests,
      avgUs: r.requests > 0 ? Math.round(r.us_sum / r.requests) : 0,
    }));
  } catch {
    return [];
  }
}
