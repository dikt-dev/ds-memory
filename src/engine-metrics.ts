/**
 * Phase 5 观察指标：按天聚合 memory/affect 的 shadow/next 行为。
 *
 * 只记录计数、字节、耗时；不记录 query/回复正文。
 * 写入失败静默；legacy 不写。
 */
import type { Env } from './types';
import { dateKeyInBeijing } from './date';

export type EngineMetricKind = 'memory' | 'affect';
export type EngineMetricMode = 'shadow' | 'next';

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
       ORDER BY day_key DESC, channel, kind, mode`,
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
