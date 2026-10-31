/**
 * 记忆的"复习"与"突然想起来"。
 *
 * 遗忘曲线原来只有单向衰减：同样是 180 天的旧事，被想起过十次的
 * 和从没被想起过的权重一样。人不是这样忘的——复述过的记忆更难淡出。
 *
 * 两件事：
 *   1. recordRecallUsage：每轮召回命中后，给被注入的条目 +1 复习次数；
 *   2. pickDormant：从"很久没被想起、但分量不轻"的条目里挑一条，
 *      让主动消息偶尔翻旧账——这是"退休"不等于"消失"的出口。
 *
 * 都只加计数、不删内容。
 */
import type { Env } from './types';
import type { MemoryChunk } from './memory-domain';

/** 一次最多记录多少条（防止异常输入把 batch 撑爆）。 */
export const RECALL_USAGE_MAX_IDS = 20;

export async function recordRecallUsage(
  env: Env,
  ids: string[],
  nowMs = Date.now(),
): Promise<number> {
  const unique = [...new Set(ids.filter((id) => typeof id === 'string' && id))].slice(
    0,
    RECALL_USAGE_MAX_IDS,
  );
  if (unique.length === 0) return 0;
  const placeholders = unique.map(() => '?').join(',');
  try {
    await env.DB.prepare(
      `UPDATE memory_chunks SET use_count = COALESCE(use_count, 0) + 1, last_used_at = ?
       WHERE id IN (${placeholders})`,
    )
      .bind(nowMs, ...unique)
      .run();
    return unique.length;
  } catch {
    // 复习计数是锦上添花：写不进去不能影响这一轮回复
    return 0;
  }
}

/** 候选门槛：至少这么多天没被想起，才算"沉睡"。 */
export const DORMANT_MIN_AGE_DAYS = 45;
/** 太近的事不算"旧事"。 */
export const DORMANT_MAX_AGE_DAYS = 900;
/** 重要性下限：太琐碎的旧事翻出来只会显得莫名其妙。 */
export const DORMANT_MIN_IMPORTANCE = 2;

export interface DormantPick {
  id: string;
  content: string;
  section: string;
  date: string | null;
}

function daysSince(dateStr: string | null, nowMs: number): number | null {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  const ts = Date.parse(`${dateStr}T00:00:00+08:00`);
  if (!Number.isFinite(ts)) return null;
  return Math.max(0, (nowMs - ts) / 86_400_000);
}

/**
 * 从记忆池里挑"沉睡但值得被想起"的条目（纯函数，便于测试）。
 *
 * 打分：重要性高、年龄在区间内、几乎没被复习过 → 分高。
 * 排除核心区（那是每轮都注入的，谈不上"突然想起来"）。
 */
export function pickDormant(
  chunks: MemoryChunk[],
  nowMs = Date.now(),
  opts: { random?: () => number; maxAgeDays?: number; minAgeDays?: number } = {},
): DormantPick | null {
  const rand = opts.random ?? Math.random;
  const minAge = opts.minAgeDays ?? DORMANT_MIN_AGE_DAYS;
  const maxAge = opts.maxAgeDays ?? DORMANT_MAX_AGE_DAYS;
  const scored: Array<{ chunk: MemoryChunk; score: number }> = [];
  for (const chunk of chunks) {
    const age = daysSince(chunk.date, nowMs);
    if (age === null || age < minAge || age > maxAge) continue;
    if (chunk.importance < DORMANT_MIN_IMPORTANCE) continue;
    if (!chunk.content || chunk.content.length < 8) continue;
    // 复习过的说明一直在用，不算沉睡
    const used = Number(chunk.useCount) || 0;
    if (used > 2) continue;
    const score = chunk.importance / (1 + used) + rand() * 0.3;
    scored.push({ chunk, score });
  }
  if (scored.length === 0) return null;
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0].chunk;
  return { id: best.id, content: best.content, section: best.section, date: best.date };
}

/** 从库里取候选池（只读，取不到就返回空）。 */
export async function loadDormantCandidates(
  env: Env,
  nowMs = Date.now(),
  limit = 500,
): Promise<MemoryChunk[]> {
  const cutoff = new Date(nowMs - DORMANT_MIN_AGE_DAYS * 86_400_000 + 8 * 3600 * 1000)
    .toISOString()
    .slice(0, 10);
  try {
    const rows = await env.DB.prepare(
      `SELECT id, source, source_id, section, content, date, keywords, tags,
              importance, content_hash, updated_at, use_count, last_used_at
       FROM memory_chunks
       WHERE date IS NOT NULL AND date <= ? AND importance >= ?
         AND COALESCE(use_count, 0) <= 2
       ORDER BY importance DESC, date ASC
       LIMIT ?`,
    )
      .bind(cutoff, DORMANT_MIN_IMPORTANCE, limit)
      .all<{
        id: string;
        source: MemoryChunk['source'];
        source_id: string;
        section: string;
        content: string;
        date: string | null;
        keywords: string;
        tags: string;
        importance: number;
        content_hash: string;
        updated_at: number;
        use_count: number | null;
        last_used_at: number | null;
      }>();
    return (rows.results ?? []).map((r) => ({
      id: r.id,
      source: r.source,
      sourceId: r.source_id,
      section: r.section,
      content: r.content,
      date: r.date,
      keywords: JSON.parse(r.keywords || '[]') as string[],
      tags: JSON.parse(r.tags || '[]') as string[],
      importance: r.importance,
      contentHash: r.content_hash,
      updatedAt: r.updated_at,
      useCount: Number(r.use_count) || 0,
      lastUsedAt: r.last_used_at ?? null,
    }));
  } catch {
    return [];
  }
}

/** 拼进提示词的一行：语气中性，不要替她编情绪。 */
export function formatDormantHint(pick: DormantPick): string {
  const when = pick.date ? `（${pick.date}）` : '';
  return `很久以前的一件事${when}：${pick.content}`;
}
