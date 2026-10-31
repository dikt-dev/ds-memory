/**
 * 成本看板：按天 × 渠道 × 模型聚合 token 与费用，重点看「缓存命中率」。
 *
 * 为什么要单独一张表：messages 里只存了总 prompt_tokens，看不出命中/未命中的比例，
 * 而命中价（¥0.04/M）和未命中价（¥2/M）差 50 倍——看不见就优化不了。
 */
import type { Env } from './types';
import { dateKeyInBeijing } from './date';
import { logError, logWarn } from './error-log';

export interface UsageInput {
  channel: string;
  model: string;
  promptHit: number;
  promptMiss: number;
  completion: number;
  costRmb: number;
  now?: number;
}

export interface UsageRow {
  day_key: string;
  channel: string;
  model: string;
  calls: number;
  prompt_hit: number;
  prompt_miss: number;
  completion: number;
  cost_rmb: number;
}

export interface UsageSummary {
  days: number;
  calls: number;
  promptTokens: number;
  promptHit: number;
  promptMiss: number;
  completionTokens: number;
  /** 命中率 0–1 */
  hitRate: number;
  costRmb: number;
  /** 单次平均费用（元） */
  costPerCall: number;
  /** 按当前速度推算的月费用（元；按 days 天外推 30 天） */
  monthlyProjection: number;
}

let ensured = false;

export async function ensureUsageTable(env: Env): Promise<void> {
  if (ensured) return;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS chat_usage (
       day_key TEXT NOT NULL,
       channel TEXT NOT NULL,
       model TEXT NOT NULL,
       calls INTEGER NOT NULL DEFAULT 0,
       prompt_hit INTEGER NOT NULL DEFAULT 0,
       prompt_miss INTEGER NOT NULL DEFAULT 0,
       completion INTEGER NOT NULL DEFAULT 0,
       cost_rmb REAL NOT NULL DEFAULT 0,
       updated_at INTEGER NOT NULL,
       PRIMARY KEY (day_key, channel, model)
     )`,
  ).run();
  ensured = true;
}

export async function recordChatUsage(env: Env, input: UsageInput): Promise<void> {
  const day = dateKeyInBeijing(new Date(input.now ?? Date.now()));
  try {
    await ensureUsageTable(env);
    await env.DB.prepare(
      `INSERT INTO chat_usage
        (day_key, channel, model, calls, prompt_hit, prompt_miss, completion, cost_rmb, updated_at)
       VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)
       ON CONFLICT(day_key, channel, model) DO UPDATE SET
         calls = calls + 1,
         prompt_hit = prompt_hit + excluded.prompt_hit,
         prompt_miss = prompt_miss + excluded.prompt_miss,
         completion = completion + excluded.completion,
         cost_rmb = cost_rmb + excluded.cost_rmb,
         updated_at = excluded.updated_at`,
    )
      .bind(
        day,
        input.channel,
        input.model,
        Math.max(0, Math.round(input.promptHit)),
        Math.max(0, Math.round(input.promptMiss)),
        Math.max(0, Math.round(input.completion)),
        input.costRmb,
        input.now ?? Date.now(),
      )
      .run();
  } catch (e) {
    // 记账失败不影响聊天，但必须留痕：静默吞错会让成本看板空一周都没人发现。
    logError('[usage] record failed:', e);
  }
}

export async function readUsageStats(env: Env, days = 7): Promise<UsageRow[]> {
  const now = new Date();
  const cutoff = dateKeyInBeijing(new Date(now.getTime() - Math.max(1, days - 1) * 86400000));
  try {
    await ensureUsageTable(env);
    const rows = await env.DB.prepare(
      `SELECT day_key, channel, model, calls, prompt_hit, prompt_miss, completion, cost_rmb
       FROM chat_usage
       WHERE day_key >= ?
       ORDER BY day_key DESC, channel, model`,
    )
      .bind(cutoff)
      .all<UsageRow>();
    return rows.results ?? [];
  } catch {
    return [];
  }
}

export function summarizeUsage(rows: UsageRow[], days = 7): UsageSummary {
  const total = rows.reduce(
    (acc, r) => ({
      calls: acc.calls + r.calls,
      hit: acc.hit + r.prompt_hit,
      miss: acc.miss + r.prompt_miss,
      completion: acc.completion + r.completion,
      cost: acc.cost + r.cost_rmb,
    }),
    { calls: 0, hit: 0, miss: 0, completion: 0, cost: 0 },
  );
  const promptTokens = total.hit + total.miss;
  const safeDays = Math.max(1, days);
  return {
    days: safeDays,
    calls: total.calls,
    promptTokens,
    promptHit: total.hit,
    promptMiss: total.miss,
    completionTokens: total.completion,
    hitRate: promptTokens > 0 ? total.hit / promptTokens : 0,
    costRmb: Number(total.cost.toFixed(4)),
    costPerCall: total.calls > 0 ? Number((total.cost / total.calls).toFixed(5)) : 0,
    monthlyProjection: Number(((total.cost / safeDays) * 30).toFixed(2)),
  };
}