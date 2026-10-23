/**
 * 时间金字塔：把记忆条目滚成「周摘要 / 月摘要」。
 *
 * 用途：条目越来越多时，只让摘要参与常规召回，原始条目靠强关键词/向量命中，
 * 越老的记忆占用越少召回名额，同时本体（memory.md / archive / 日-月日志）永远完整。
 */
import type { Env } from './types';
import { distillText } from './distill';

const ROLLUP_SYSTEM = `你是记忆压缩助手。把一组记忆条目浓缩成一条简短的周/月摘要：
- 只保留之后聊天可能被提起的事实：项目进展、决定、约定、重要事件、数字、专有名词；
- 用电报体 + 「；」分句，半角标点，总长 ≤ 300 字；
- 不要编造条目里没有的内容；没有可保留的就输出「（无）」；
- 直接输出摘要文本，不要标题、不要解释。`;

export interface MemoryRollup {
  id: string;
  level: 'week' | 'month';
  period: string;
  content: string;
  entry_count: number;
  created_at: number;
  updated_at: number;
}

/** 北京时间的"周一"日期键（YYYY-MM-DD）。 */
export function weekStartKey(dateKey: string): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 0, 0, 0));
  const day = dt.getUTCDay(); // 0=周日
  const diff = day === 0 ? 6 : day - 1; // 周一为一周开始
  dt.setUTCDate(dt.getUTCDate() - diff);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

/** 上一个完整周（周一）与上一个完整月的周期键。 */
export function previousPeriods(todayKey: string): { week: string; month: string } {
  const [y, m] = todayKey.split('-').map(Number);
  const thisWeek = weekStartKey(todayKey);
  const [wy, wm, wd] = thisWeek.split('-').map(Number);
  const lastWeek = new Date(Date.UTC(wy, wm - 1, wd - 7));
  const lastWeekKey = `${lastWeek.getUTCFullYear()}-${String(lastWeek.getUTCMonth() + 1).padStart(2, '0')}-${String(lastWeek.getUTCDate()).padStart(2, '0')}`;
  const prevMonth = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
  return { week: lastWeekKey, month: prevMonth };
}

function dateRangeOf(level: 'week' | 'month', period: string): { start: string; end: string } {
  if (level === 'week') {
    const [y, mo, d] = period.split('-').map(Number);
    const start = new Date(Date.UTC(y, mo - 1, d, 0, 0, 0));
    const end = new Date(start.getTime() + 6 * 86400000);
    const fmt = (x: Date) =>
      `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, '0')}-${String(x.getUTCDate()).padStart(2, '0')}`;
    return { start: fmt(start), end: fmt(end) };
  }
  return { start: `${period}-01`, end: `${period}-31` };
}

/** 生成/更新一个周或月摘要（幂等覆盖写）。 */
export async function generateRollup(
  env: Env,
  level: 'week' | 'month',
  period: string,
): Promise<MemoryRollup | null> {
  const { start, end } = dateRangeOf(level, period);
  const rows = await env.DB.prepare(
    `SELECT content, date FROM memory_entries
     WHERE date IS NOT NULL AND date >= ? AND date <= ?
     ORDER BY date ASC`,
  )
    .bind(start, end)
    .all<{ content: string; date: string | null }>();
  const items = rows.results ?? [];
  const existing = await env.DB.prepare('SELECT content FROM memory_rollups WHERE id = ?')
    .bind(`${level}:${period}`)
    .first<{ content: string }>();
  const input = `${existing?.content ? `【现有摘要】\n${existing.content}\n\n` : ''}【该周期记忆条目 ${items.length} 条】\n${items
    .map((r) => `- ${r.date ? `[${r.date}] ` : ''}${r.content}`)
    .join('\n')
    .slice(0, 12000)}`;

  const result = await distillText(
    env,
    ROLLUP_SYSTEM,
    input,
    512,
    env.SUMMARY_DEEPSEEK_MODEL || env.DEEPSEEK_MODEL,
  );
  const content = result.text.slice(0, 600).trim();
  if (!content || content === '（无）') {
    // 无内容也记录，避免每天重复生成
    await env.DB.prepare(
      `INSERT OR REPLACE INTO memory_rollups (id, level, period, content, entry_count, created_at, updated_at)
       VALUES (?, ?, ?, '（无）', ?, ?, ?)`,
    )
      .bind(`${level}:${period}`, level, period, items.length, Date.now(), Date.now())
      .run()
      .catch(() => {});
    return null;
  }
  const now = Date.now();
  const id = `${level}:${period}`;
  await env.DB.prepare(
    `INSERT OR REPLACE INTO memory_rollups (id, level, period, content, entry_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, level, period, content, items.length, now, now)
    .run();
  return { id, level, period, content, entry_count: items.length, created_at: now, updated_at: now };
}

/** 周一生成上周摘要、每月 1 日生成上月摘要（幂等覆盖，可重复执行）。 */
export async function maybeGenerateRollups(
  env: Env,
  now: Date,
): Promise<{ generated: string[]; errors: string[] }> {
  // 北京时间的"今天"与星期
  const beijing = new Date(now.getTime() + 8 * 3600 * 1000);
  const dayOfWeek = beijing.getUTCDay(); // 1=周一
  const dayOfMonth = beijing.getUTCDate();
  const todayKey = `${beijing.getUTCFullYear()}-${String(beijing.getUTCMonth() + 1).padStart(2, '0')}-${String(beijing.getUTCDate()).padStart(2, '0')}`;

  const generated: string[] = [];
  const errors: string[] = [];
  if (dayOfWeek === 1) {
    try {
      const r = await generateRollup(env, 'week', previousPeriods(todayKey).week);
      if (r) generated.push(`week:${r.period}(${r.entry_count}条)`);
    } catch (e) {
      errors.push(String(e));
    }
  }
  if (dayOfMonth === 1) {
    try {
      const r = await generateRollup(env, 'month', previousPeriods(todayKey).month);
      if (r) generated.push(`month:${r.period}(${r.entry_count}条)`);
    } catch (e) {
      errors.push(String(e));
    }
  }
  if (generated.length === 0 && errors.length === 0) {
    // 非周一且非 1 号：无事可做
  }
  return { generated, errors };
}

let rollupCache: { key: string; rows: MemoryRollup[] } | null = null;

/** 读取全部摘要（数量很小，直接全量；带 isolate 缓存）。 */
export async function loadRollups(env: Env): Promise<MemoryRollup[]> {
  const meta = await env.DB.prepare(
    'SELECT COUNT(*) AS c, COALESCE(MAX(updated_at), 0) AS m FROM memory_rollups',
  ).first<{ c: number; m: number }>();
  const key = `${meta?.c ?? 0}|${meta?.m ?? 0}`;
  if (rollupCache && rollupCache.key === key) return rollupCache.rows;
  const all = await env.DB.prepare(
    'SELECT id, level, period, content, entry_count, created_at, updated_at FROM memory_rollups ORDER BY period DESC',
  ).all<MemoryRollup>();
  rollupCache = { key, rows: all.results ?? [] };
  return rollupCache.rows;
}
