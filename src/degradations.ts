/**
 * 静默降级记账（审查第 8 条）。
 *
 * 记忆/存储/召回出问题时，业务上必须"降级但不报错"——聊天不能因为 R2 挂了就 500。
 * 代价是：降级之后没人知道。健康分里原本只有"结果类"信号（命中率、抱怨、延迟），
 * 看不见"某个子系统在悄悄失败"。
 *
 * 这里只做一件事：把降级次数按天累加进 D1，健康分再按每百次请求的降级次数扣分。
 * 不加时间序列、不存正文，只存「哪一天、哪个部件、多少次」。
 */
import type { Env } from './types';

export interface DegradationRow {
  day_key: string;
  component: string;
  hits: number;
}

/** 已知部件——白名单，避免把随机字符串写进表里。 */
export const DEGRADATION_COMPONENTS = [
  'r2_read', // 读对象失败（主账号 R2 抛错）
  'r2_write', // 写对象失败/回读校验不一致
  'kv_read', // KV 读取失败
  'recall', // 召回超时或引擎异常
  'embed', // 向量嵌入失败（退回关键词）
  'emotion', // 情绪结算失败
  'self_check', // 自检/自审读不到依赖
  'tts', // 语音合成失败
] as const;

export type DegradationComponent = (typeof DEGRADATION_COMPONENTS)[number];

export const DEGRADATION_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS degradation_log (
  day_key TEXT NOT NULL,
  component TEXT NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0,
  last_at INTEGER NOT NULL,
  PRIMARY KEY (day_key, component)
)`;

let ensured = false;

/** 建表是幂等的，但每条请求都建一次太浪费：进程内只做一次。 */
async function ensureTable(env: Env): Promise<void> {
  if (ensured) return;
  await env.DB.prepare(DEGRADATION_TABLE_DDL).run();
  ensured = true;
}

/**
 * 记一次降级。**永不抛异常**：它自己被调用时就处在降级路径上，
 * 再抛一次只会把"记忆挂了"升级成"聊天挂了"。
 *
 * 故意不 await 的用法是允许的（调用方 fire-and-forget），
 * 但要在测试里 await 同一个 Promise。
 */
export async function recordDegradation(
  env: Env,
  component: DegradationComponent,
  hits = 1,
): Promise<void> {
  try {
    await ensureTable(env);
    const dayKey = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
    await env.DB.prepare(
      `INSERT INTO degradation_log (day_key, component, hits, last_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(day_key, component) DO UPDATE SET hits = hits + excluded.hits, last_at = excluded.last_at`,
    )
      .bind(dayKey, component, Math.max(1, Math.floor(hits)), Date.now())
      .run();
  } catch {
    // 记账失败不影响业务：这条路径本来就是降级路径。
  }
}

/** 读最近 N 天的降级计数；表不存在时返回空。 */
export async function readDegradations(env: Env, days = 7): Promise<DegradationRow[]> {
  const window = Math.min(30, Math.max(1, Math.floor(days)));
  const from = new Date(Date.now() + 8 * 3600 * 1000 - (window - 1) * 86400000)
    .toISOString()
    .slice(0, 10);
  try {
    const res = await env.DB.prepare(
      `SELECT day_key, component, hits FROM degradation_log
       WHERE day_key >= ? ORDER BY day_key DESC, hits DESC`,
    )
      .bind(from)
      .all<DegradationRow>();
    return res.results ?? [];
  } catch {
    return [];
  }
}

/** 窗口内总降级次数。 */
export function totalDegradations(rows: DegradationRow[]): number {
  return rows.reduce((sum, r) => sum + (Number(r.hits) || 0), 0);
}

/** 部件分布：给管理端看"哪块在坏"。 */
export function degradationBreakdown(rows: DegradationRow[]): Array<{ component: string; hits: number }> {
  const map = new Map<string, number>();
  for (const r of rows) map.set(r.component, (map.get(r.component) ?? 0) + (Number(r.hits) || 0));
  return [...map.entries()]
    .map(([component, hits]) => ({ component, hits }))
    .sort((a, b) => b.hits - a.hits);
}
