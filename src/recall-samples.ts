/**
 * recall-samples.ts —— 召回分段耗时的逐条采样。
 *
 * 为什么要它：engine_metrics 只有一个总耗时，503ms 到底花在「读 chunks / 排序 /
 * 调向量 / 扩关联 / 旧引擎」哪一段，看不出来。看不见就只能猜着优化。
 *
 * 为什么不用 engine_metrics 加列：那张表是按天聚合的，平均值会把长尾抹平；
 * 延迟要看 p50/p95，得留原始样本。一天约 100 行，代价可以忽略。
 *
 * 不记录 query 与正文，只有数字。
 */
import type { Env } from './types';
import { dateKeyInBeijing } from './date';

export interface RecallSample {
  channel: string;
  mode: string;
  kind: string;
  legacyMs: number;
  loadMs: number;
  rankMs: number;
  embedMs: number;
  expandMs: number;
  totalMs: number;
  items: number;
  linked: number;
  hasVector: boolean;
  timedOut: boolean;
  /**
   * 旧引擎这一侧是不是被「跳过」了（不是「返回空」）。
   *
   * 手机上全量记忆已经整块塞进提示词，legacy 召回被 skipMemorySource 主动跳过，
   * old_items 因此恒为 0。如果不区分「跳过」和「返回空」，这份对比数据会被
   * 误读成「旧召回很差」，实际是「旧召回压根没跑」。
   */
  legacySkipped: boolean;
  /** 这一轮拆出来的检索意图（P1-1）；没有就空数组。 */
  intents?: string[];
  /** 选择器真正选中的条数（扩展前）。items 是扩展+封顶后的，两者差多少要看得见。 */
  picked?: number;
}

export interface RecallSampleRow extends RecallSample {
  day_key: string;
  created_at: number;
}

/** 建表只做一次（isolate 内存标记）。DDL 失败不影响聊天。 */
let ensured = false;
export async function ensureRecallSampleTable(env: Env): Promise<void> {
  if (ensured) return;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS recall_samples (
       id          INTEGER PRIMARY KEY AUTOINCREMENT,
       day_key     TEXT NOT NULL,
       channel     TEXT NOT NULL,
       mode        TEXT NOT NULL,
       kind        TEXT NOT NULL,
       legacy_ms   INTEGER NOT NULL DEFAULT 0,
       load_ms     INTEGER NOT NULL DEFAULT 0,
       rank_ms     INTEGER NOT NULL DEFAULT 0,
       embed_ms    INTEGER NOT NULL DEFAULT 0,
       expand_ms   INTEGER NOT NULL DEFAULT 0,
       total_ms    INTEGER NOT NULL DEFAULT 0,
       items       INTEGER NOT NULL DEFAULT 0,
       linked      INTEGER NOT NULL DEFAULT 0,
       has_vector  INTEGER NOT NULL DEFAULT 0,
       timed_out   INTEGER NOT NULL DEFAULT 0,
       legacy_skipped INTEGER NOT NULL DEFAULT 0,
       created_at  INTEGER NOT NULL)
   `.trim(),
  ).run();
  // 按天/模式聚合是热路径（健康分、样本统计都查这张表）。
  await env.DB.prepare(
    'CREATE INDEX IF NOT EXISTS idx_recall_samples_day ON recall_samples(day_key, mode)',
  ).run();
  // 老表没有这一列（CREATE IF NOT EXISTS 不会补列），单独加一次；已存在会抛，忽略。
  await env.DB.prepare(
    'ALTER TABLE recall_samples ADD COLUMN legacy_skipped INTEGER NOT NULL DEFAULT 0',
  )
    .run()
    .catch(() => undefined);
  await env.DB.prepare('ALTER TABLE recall_samples ADD COLUMN intents TEXT')
    .run()
    .catch(() => undefined);
  await env.DB.prepare('ALTER TABLE recall_samples ADD COLUMN picked INTEGER NOT NULL DEFAULT 0')
    .run()
    .catch(() => undefined);
  ensured = true;
}

const ms = (n: number) => Math.max(0, Math.round(Number.isFinite(n) ? n : 0));

export async function recordRecallSample(env: Env, s: RecallSample, now = Date.now()): Promise<void> {
  try {
    await ensureRecallSampleTable(env);
    await env.DB.prepare(
      `INSERT INTO recall_samples
         (day_key, channel, mode, kind, legacy_ms, load_ms, rank_ms, embed_ms,
          expand_ms, total_ms, items, linked, has_vector, timed_out, legacy_skipped,
          intents, picked, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        dateKeyInBeijing(new Date(now)),
        s.channel,
        s.mode,
        s.kind,
        ms(s.legacyMs),
        ms(s.loadMs),
        ms(s.rankMs),
        ms(s.embedMs),
        ms(s.expandMs),
        ms(s.totalMs),
        ms(s.items),
        ms(s.linked),
        s.hasVector ? 1 : 0,
        s.timedOut ? 1 : 0,
        s.legacySkipped ? 1 : 0,
        s.intents && s.intents.length > 0 ? JSON.stringify(s.intents) : null,
        Math.max(0, Math.round(s.picked ?? 0)),
        now,
      )
      .run();
  } catch {
    // 采样失败不影响聊天
  }
}

/** 清掉过期样本（每日归档调用）。失败静默——采样表是辅助数据。 */
export async function pruneRecallSamples(env: Env, keepDays = 14): Promise<number> {
  try {
    await ensureRecallSampleTable(env);
    const cutoff = dateKeyInBeijing(new Date(Date.now() - Math.max(1, keepDays) * 86400000));
    const res = await env.DB.prepare('DELETE FROM recall_samples WHERE day_key < ?')
      .bind(cutoff)
      .run();
    return res.meta?.changes ?? 0;
  } catch {
    return 0;
  }
}

/** 最近 N 天的原始样本（默认 3 天，够看趋势又不至于把响应撑爆）。 */
export async function readRecallSamples(env: Env, days = 3): Promise<RecallSampleRow[]> {
  const cutoff = dateKeyInBeijing(new Date(Date.now() - Math.max(1, days) * 86400000));
  const rows = await env.DB.prepare(
    `SELECT day_key, channel, mode, kind, legacy_ms, load_ms, rank_ms, embed_ms,
            expand_ms, total_ms, items, linked, has_vector, timed_out, legacy_skipped,
            created_at
       FROM recall_samples
      WHERE day_key >= ?
      ORDER BY id DESC
      LIMIT 5000`,
  )
    .bind(cutoff)
    .all<{
      day_key: string;
      channel: string;
      mode: string;
      kind: string;
      legacy_ms: number;
      load_ms: number;
      rank_ms: number;
      embed_ms: number;
      expand_ms: number;
      total_ms: number;
      items: number;
      linked: number;
      has_vector: number;
      timed_out: number;
      legacy_skipped: number;
      created_at: number;
    }>();
  return (rows.results ?? []).map((r) => ({
    day_key: r.day_key,
    channel: r.channel,
    mode: r.mode,
    kind: r.kind,
    legacyMs: r.legacy_ms,
    loadMs: r.load_ms,
    rankMs: r.rank_ms,
    embedMs: r.embed_ms,
    expandMs: r.expand_ms,
    totalMs: r.total_ms,
    items: r.items,
    linked: r.linked,
    hasVector: r.has_vector === 1,
    timedOut: r.timed_out === 1,
    legacySkipped: r.legacy_skipped === 1,
    created_at: r.created_at,
  }));
}

/** 分位数（线性插值）。延迟要看 p50/p95，平均值会被长尾带偏。 */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[idx];
}

export interface StageSummary {
  n: number;
  total: { p50: number; p95: number; max: number };
  stages: Record<'legacy' | 'load' | 'rank' | 'embed' | 'expand', { p50: number; p95: number }>;
  /** p95 里各段的占比（0-1），用来快速看谁是大头 */
  share: Record<'legacy' | 'load' | 'rank' | 'embed' | 'expand', number>;
  timedOutRate: number;
  avgItems: number;
}

export function summarizeSamples(rows: RecallSampleRow[]): StageSummary | null {
  if (rows.length === 0) return null;
  const col = (pick: (r: RecallSampleRow) => number) => rows.map(pick);
  const legacy = col((r) => r.legacyMs);
  const load = col((r) => r.loadMs);
  const rank = col((r) => r.rankMs);
  const embed = col((r) => r.embedMs);
  const expand = col((r) => r.expandMs);
  const total = col((r) => r.totalMs);
  const p95 = (v: number[]) => percentile(v, 95);
  const stageP95 = {
    legacy: p95(legacy),
    load: p95(load),
    rank: p95(rank),
    embed: p95(embed),
    expand: p95(expand),
  };
  const sum = Object.values(stageP95).reduce((a, b) => a + b, 0);
  const share = Object.fromEntries(
    Object.entries(stageP95).map(([k, v]) => [k, sum > 0 ? Math.round((v / sum) * 1000) / 1000 : 0]),
  ) as StageSummary['share'];
  return {
    n: rows.length,
    total: { p50: percentile(total, 50), p95: p95(total), max: Math.max(...total) },
    stages: {
      legacy: { p50: percentile(legacy, 50), p95: p95(legacy) },
      load: { p50: percentile(load, 50), p95: p95(load) },
      rank: { p50: percentile(rank, 50), p95: p95(rank) },
      embed: { p50: percentile(embed, 50), p95: p95(embed) },
      expand: { p50: percentile(expand, 50), p95: p95(expand) },
    },
    share,
    timedOutRate: rows.filter((r) => r.timedOut).length / rows.length,
    avgItems: Math.round((rows.reduce((a, r) => a + r.items, 0) / rows.length) * 10) / 10,
  };
}