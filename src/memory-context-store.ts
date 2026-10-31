/**
 * Memory Context 的 D1 持久化（Phase 2）。
 *
 * 当前阶段以 memory.md 为唯一导入源：解析 → facts/events/chunks → D1。
 * 旧表 memory_entries / 旧召回路径完全不动，便于影子对比与回滚。
 */
import type { Env } from './types';
import { assertAllowed } from './policy';
import { expireSupersededFacts } from './fact-expiry';
import { confidenceForSource, mergeConfidence } from './fact-confidence';
import { autoTags, bigrams } from './memory-archive';
import { embedTexts, quantizeVec } from './memory-index';
import { rollupSourceHash } from './memory-rollups';
import { linkFactToNeighbors } from './memory-links';
import {
  buildMemoryChunks,
  canonicalizeFacts,
  parseArchiveContext,
  parseMemoryContext,
  stableHash,
  type MemoryChunk,
  type MemoryEvent,
  type MemoryFact,
} from './memory-domain';

export interface MemoryContextStats {
  facts: number;
  events: number;
  summaries: number;
  chunks: number;
  embedded: number;
}

export interface ReplaceMemoryContextResult extends MemoryContextStats {
  origin: string;
}

const BATCH = 50;

function chunksOf<T>(items: T[], size = BATCH): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function json<T>(value: T): string {
  return JSON.stringify(value);
}

function parseArray<T>(raw: string): T[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

async function insertFacts(env: Env, facts: MemoryFact[], origin: string): Promise<void> {
  // 不变量 4：对话抽取的事实必须能指回消息；memory.md / correction 来源的出处是
  // 文档本身（memory.md 就是人写的记录），所以按"已归档来源"放行。
  const provenance = facts.flatMap((f) => f.sourceMessageIds ?? []);
  assertAllowed(
    { kind: 'fact.upsert', sourceMessageIds: provenance, legacyOrigin: origin !== 'conversation' },
    { actor: 'job' },
  );
  for (const batch of chunksOf(facts)) {
    await env.DB.batch(
      batch.map((f) =>
        env.DB.prepare(
          `INSERT OR REPLACE INTO memory_facts
           (id, section, content, subject, predicate, object, valid_from, valid_to,
            confidence, source_message_ids, tags, content_hash, origin, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          f.id,
          f.section,
          f.content,
          f.subject,
          f.predicate,
          f.object,
          f.validFrom,
          f.validTo,
          f.confidence,
          json(f.sourceMessageIds),
          json(f.tags),
          f.contentHash,
          origin,
          f.createdAt,
          f.updatedAt,
        ),
      ),
    );
  }
  // ADR-001 S4：对话抽取的新事实会顶掉同 (subject, predicate) 的旧事实。
  // 只在 conversation origin 上跑——memory.md 重建时的事实顺序不代表时间顺序。
  if (origin === 'conversation') {
    await expireSupersededFacts(
      env,
      facts,
      Date.now(),
      new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10),
    ).catch(() => 0);
  }
}

async function insertEvents(env: Env, events: MemoryEvent[], origin: string): Promise<void> {
  for (const batch of chunksOf(events)) {
    await env.DB.batch(
      batch.map((e) =>
        env.DB.prepare(
          `INSERT OR REPLACE INTO memory_events
           (id, section, date_key, summary, participants, emotions,
            source_message_ids, content_hash, origin, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          e.id,
          e.section,
          e.dateKey,
          e.summary,
          e.participants,
          e.emotions,
          json(e.sourceMessageIds),
          e.contentHash,
          origin,
          e.createdAt,
        ),
      ),
    );
  }
}

async function insertChunks(env: Env, chunks: MemoryChunk[], origin: string): Promise<void> {
  for (const batch of chunksOf(chunks)) {
    await env.DB.batch(
      batch.map((c) =>
        env.DB.prepare(
          `INSERT OR REPLACE INTO memory_chunks
           (id, source, source_id, section, content, date, keywords, tags,
            importance, vec, content_hash, origin, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          c.id,
          c.source,
          c.sourceId,
          c.section,
          c.content,
          c.date,
          json(c.keywords),
          json(c.tags),
          c.importance,
          c.vec ?? null,
          c.contentHash,
          origin,
          c.updatedAt,
        ),
      ),
    );
  }
}

async function staleIds(env: Env, table: string, origin: string, keep: Set<string>): Promise<string[]> {
  const rows = await env.DB.prepare(`SELECT id FROM ${table} WHERE origin = ?`)
    .bind(origin)
    .all<{ id: string }>();
  return (rows.results ?? []).map((r) => r.id).filter((id) => !keep.has(id));
}

/** 把一批事实标记为失效（保留行与出处，供时间旅行查询）。 */
async function expireFactRows(env: Env, ids: string[], nowMs: number): Promise<void> {
  if (ids.length === 0) return;
  const iso = new Date(nowMs + 8 * 3600 * 1000).toISOString().slice(0, 10);
  for (const batch of chunksOf(ids)) {
    const placeholders = batch.map(() => '?').join(',');
    await env.DB.prepare(
      `UPDATE memory_facts SET valid_to = COALESCE(valid_to, ?), updated_at = ?
       WHERE id IN (${placeholders})`,
    )
      .bind(iso, nowMs, ...batch)
      .run();
  }
}

async function deleteIds(env: Env, table: string, ids: string[]): Promise<void> {
  for (const batch of chunksOf(ids)) {
    const placeholders = batch.map(() => '?').join(',');
    await env.DB.prepare(`DELETE FROM ${table} WHERE id IN (${placeholders})`)
      .bind(...batch)
      .run();
  }
}

/**
 * 写入从对话抽取的事实（origin=conversation）。
 * 同一 fact 重复出现时合并 source_message_ids，而不是覆盖丢证据。
 */
export async function upsertConversationFacts(env: Env, facts: MemoryFact[]): Promise<number> {
  if (facts.length === 0) return 0;
  const existing = await env.DB.prepare(
    `SELECT id, source_message_ids, confidence FROM memory_facts WHERE origin = 'conversation'`,
  ).all<{ id: string; source_message_ids: string; confidence: number }>();
  const old = new Map(
    (existing.results ?? []).map((r) => [r.id, parseArray<number>(r.source_message_ids)]),
  );
  const oldConfidence = new Map(
    (existing.results ?? []).map((r) => [r.id, Number(r.confidence) || 0]),
  );
  for (const fact of facts) {
    const previous = old.get(fact.id) ?? [];
    fact.sourceMessageIds = [...new Set([...previous, ...fact.sourceMessageIds])].sort((a, b) => a - b);
    // ADR-001 S5：同一事实再次出现只轻微上浮，绝不让"她自己重复"变成"更可信"。
    const prior = oldConfidence.get(fact.id);
    if (prior !== undefined) fact.confidence = mergeConfidence(prior, fact.confidence);
    else if (!fact.confidence) fact.confidence = confidenceForSource('conversation');
  }
  await insertFacts(env, facts, 'conversation');
  await insertChunks(env, buildMemoryChunks({ facts, events: [] }), 'conversation');
  for (const fact of facts) {
    await linkFactToNeighbors(env, fact).catch(() => 0);
  }
  return facts.length;
}

/**
 * 用一份 memory.md 覆盖指定 origin 的 facts/events/chunks。
 *
 * 先 upsert 当前行，再删除旧行；如果中途失败，旧数据仍在（不会先清空）。
 */
export async function replaceMemoryContext(
  env: Env,
  text: string,
  origin = 'legacy',
  now = Date.now(),
): Promise<ReplaceMemoryContextResult> {
  const parsed = parseMemoryContext(text, now);
  // 过滤过期事实 + 同槽位去重；保留较新事实并合并来源。
  const today = new Date(now + 8 * 3600 * 1000).toISOString().slice(0, 10);
  parsed.facts = canonicalizeFacts(parsed.facts, today);
  const chunks = buildMemoryChunks(parsed, now);

  // 保留已回填的来源：reparse 出来的 fact 默认 source_message_ids=[]，
  // 若不合并，每日重建会把 provenance 清空。
  const existing = await env.DB.prepare(
    `SELECT id, source_message_ids FROM memory_facts WHERE origin = ?`,
  )
    .bind(origin)
    .all<{ id: string; source_message_ids: string }>();
  const existingSources = new Map(
    (existing.results ?? []).map((r) => [r.id, parseArray<number>(r.source_message_ids)]),
  );
  const existingFactIds = new Set(existingSources.keys());
  for (const fact of parsed.facts) {
    if (fact.sourceMessageIds.length === 0) {
      const old = existingSources.get(fact.id);
      if (old && old.length > 0) fact.sourceMessageIds = old;
    }
  }

  const factIds = new Set(parsed.facts.map((f) => f.id));
  const eventIds = new Set(parsed.events.map((e) => e.id));
  const chunkIds = new Set(chunks.map((c) => c.id));

  const oldFacts = await staleIds(env, 'memory_facts', origin, factIds);
  const oldEvents = await staleIds(env, 'memory_events', origin, eventIds);
  const oldChunks = await staleIds(env, 'memory_chunks', origin, chunkIds);

  await insertFacts(env, parsed.facts, origin);
  await insertEvents(env, parsed.events, origin);
  await insertChunks(env, chunks, origin);
  // 只给新事实建链；存量关联保留，避免每日全表重建。
  for (const fact of parsed.facts) {
    if (existingFactIds.has(fact.id)) continue;
    await linkFactToNeighbors(env, fact).catch(() => 0);
  }

  // 不变量 2：旧事实不删，写 valid_to 留档（ADR-001 S4）。
  await expireFactRows(env, oldFacts, now);
  await deleteIds(env, 'memory_events', oldEvents);
  await deleteIds(env, 'memory_chunks', oldChunks);

  const stats = await memoryContextStats(env);
  return { origin, ...stats };
}

/** 读取全部 chunk（当前规模很小；Phase 4 改为按候选集/FTS 查询）。 */
export async function loadMemoryChunks(env: Env, limit = 1000): Promise<MemoryChunk[]> {
  const rows = await env.DB.prepare(
    `SELECT id, source, source_id, section, content, date, keywords, tags,
            importance, vec, content_hash, updated_at
     FROM memory_chunks
     ORDER BY importance DESC, date DESC, updated_at DESC
     LIMIT ?`,
  )
    .bind(limit)
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
      vec: string | null;
      content_hash: string;
      updated_at: number;
    }>();
  return (rows.results ?? []).map((r) => ({
    id: r.id,
    source: r.source,
    sourceId: r.source_id,
    section: r.section,
    content: r.content,
    date: r.date,
    keywords: parseArray<string>(r.keywords),
    tags: parseArray<string>(r.tags),
    importance: r.importance,
    vec: r.vec,
    contentHash: r.content_hash,
    updatedAt: r.updated_at,
  }));
}

/** 读取 D1 里的全部事实（投影/评测用；当前规模小）。 */
export async function loadMemoryFacts(env: Env, limit = 2000): Promise<MemoryFact[]> {
  const rows = await env.DB.prepare(
    `SELECT id, section, content, subject, predicate, object, valid_from, valid_to,
            confidence, source_message_ids, tags, content_hash, created_at, updated_at
     FROM memory_facts ORDER BY section, valid_from, id LIMIT ?`,
  )
    .bind(limit)
    .all<{
      id: string;
      section: string;
      content: string;
      subject: string | null;
      predicate: string | null;
      object: string | null;
      valid_from: string | null;
      valid_to: string | null;
      confidence: number;
      source_message_ids: string;
      tags: string;
      content_hash: string;
      created_at: number;
      updated_at: number;
    }>();
  return (rows.results ?? []).map((r) => ({
    id: r.id,
    section: r.section,
    content: r.content,
    subject: r.subject,
    predicate: r.predicate,
    object: r.object,
    validFrom: r.valid_from,
    validTo: r.valid_to,
    confidence: r.confidence,
    sourceMessageIds: parseArray<number>(r.source_message_ids),
    tags: parseArray<string>(r.tags),
    contentHash: r.content_hash,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

export async function loadMemoryEvents(env: Env, limit = 2000): Promise<MemoryEvent[]> {
  const rows = await env.DB.prepare(
    `SELECT id, section, date_key, summary, participants, emotions,
            source_message_ids, content_hash, created_at
     FROM memory_events ORDER BY date_key DESC, id LIMIT ?`,
  )
    .bind(limit)
    .all<{
      id: string;
      section: string;
      date_key: string;
      summary: string;
      participants: string;
      emotions: string;
      source_message_ids: string;
      content_hash: string;
      created_at: number;
    }>();
  return (rows.results ?? []).map((r) => ({
    id: r.id,
    section: r.section,
    dateKey: r.date_key,
    summary: r.summary,
    participants: r.participants,
    emotions: r.emotions,
    sourceMessageIds: parseArray<number>(r.source_message_ids),
    contentHash: r.content_hash,
    createdAt: r.created_at,
  }));
}

export async function loadMemoryContext(env: Env): Promise<{ facts: MemoryFact[]; events: MemoryEvent[] }> {
  const [facts, events] = await Promise.all([loadMemoryFacts(env), loadMemoryEvents(env)]);
  return { facts, events };
}

/**
 * 给还没有向量的 chunk 补 embedding（Phase 4）。
 * 失败/数量不匹配时返回 0，不影响关键词召回。
 */
export async function embedMemoryChunks(env: Env, limit = 64): Promise<number> {
  const rows = await env.DB.prepare(
    `SELECT id, content FROM memory_chunks WHERE vec IS NULL LIMIT ?`,
  )
    .bind(Math.min(200, Math.max(1, limit)))
    .all<{ id: string; content: string }>();
  const items = rows.results ?? [];
  if (items.length === 0) return 0;
  const vecs = await embedTexts(env, items.map((r) => r.content));
  if (vecs.length !== items.length) return 0;
  let n = 0;
  for (let i = 0; i < items.length; i++) {
    const vec = quantizeVec(vecs[i]);
    if (!vec) continue;
    await env.DB.prepare(`UPDATE memory_chunks SET vec = ? WHERE id = ?`)
      .bind(vec, items[i].id)
      .run();
    n += 1;
  }
  return n;
}

export async function memoryContextStats(env: Env): Promise<MemoryContextStats> {
  const row = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM memory_facts) AS facts,
       (SELECT COUNT(*) FROM memory_events) AS events,
       (SELECT COUNT(*) FROM memory_summaries) AS summaries,
       (SELECT COUNT(*) FROM memory_chunks) AS chunks,
       (SELECT COUNT(*) FROM memory_chunks WHERE vec IS NOT NULL) AS embedded`,
  ).first<{ facts: number; events: number; summaries: number; chunks: number; embedded: number }>();
  return {
    facts: Number(row?.facts) || 0,
    events: Number(row?.events) || 0,
    summaries: Number(row?.summaries) || 0,
    chunks: Number(row?.chunks) || 0,
    embedded: Number(row?.embedded) || 0,
  };
}

/**
 * 把既有 memory_rollups（周/月摘要）同步成 MemorySummary + chunk。
 * 幂等：先 upsert，再删除 origin='rollup' 里已不存在的旧 chunk。
 */
export async function syncRollupSummaries(env: Env, now = Date.now()): Promise<number> {
  const rows = await env.DB.prepare(
    `SELECT id, level, period, content, source_hash, created_at
     FROM memory_rollups
     WHERE content IS NOT NULL AND content <> '' AND content <> '（无）'
     ORDER BY period ASC`,
  ).all<{
    id: string;
    level: 'week' | 'month';
    period: string;
    content: string;
    source_hash: string | null;
    created_at: number;
  }>();
  const items = rows.results ?? [];
  const chunks: MemoryChunk[] = [];
  const summaryIds: string[] = [];

  for (const r of items) {
    // 旧摘要如果和当前记忆条目指纹不一致，先不注入，等下一次 rollup 重算。
    if (r.source_hash) {
      const start = r.level === 'week' ? r.period : `${r.period}-01`;
      let end = `${r.period}-31`;
      if (r.level === 'week') {
        const d = new Date(`${r.period}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() + 6);
        end = d.toISOString().slice(0, 10);
      }
      const entryRows = await env.DB.prepare(
        `SELECT content, date FROM memory_entries
         WHERE date IS NOT NULL AND date >= ? AND date <= ?
         ORDER BY date ASC`,
      )
        .bind(start, end)
        .all<{ content: string; date: string | null }>();
      const currentHash = rollupSourceHash(entryRows.results ?? []);
      if (currentHash !== r.source_hash) continue;
    }
    const id = `rollup:${r.id}`;
    summaryIds.push(id);
    await env.DB.prepare(
      `INSERT OR REPLACE INTO memory_summaries
       (id, level, period, content, source_ids, origin, created_at)
       VALUES (?, ?, ?, ?, ?, 'rollup', ?)`,
    )
      .bind(id, r.level, r.period, r.content, JSON.stringify([r.id]), r.created_at)
      .run();
    const date = r.level === 'month' ? `${r.period}-01` : r.period;
    chunks.push({
      id: `chunk_summary_${r.id}`,
      source: 'summary',
      sourceId: id,
      section: '摘要',
      content: r.content,
      date,
      keywords: bigrams(r.content).slice(0, 24),
      tags: autoTags(r.content, 3),
      importance: 4,
      contentHash: stableHash(r.content),
      updatedAt: now,
    });
  }

  const old = await env.DB.prepare(
    `SELECT id FROM memory_chunks WHERE origin = 'rollup' AND source = 'summary'`,
  ).all<{ id: string }>();
  const keep = new Set(chunks.map((c) => c.id));
  const stale = (old.results ?? []).map((r) => r.id).filter((id) => !keep.has(id));
  await insertChunks(env, chunks, 'rollup');
  await deleteIds(env, 'memory_chunks', stale);

  const oldSummaries = await env.DB.prepare(
    `SELECT id FROM memory_summaries WHERE origin = 'rollup'`,
  ).all<{ id: string }>();
  const keepSummaries = new Set(summaryIds);
  const staleSummaries = (oldSummaries.results ?? [])
    .map((r) => r.id)
    .filter((id) => !keepSummaries.has(id));
  await deleteIds(env, 'memory_summaries', staleSummaries);
  return items.length;
}

/** 把 archive.md 的旧事同步成 events/chunks（origin=archive）。 */
export async function syncArchiveContext(
  env: Env,
  lines: string[],
  now = Date.now(),
): Promise<number> {
  const events = parseArchiveContext(lines.slice(-500), now);
  const chunks = buildMemoryChunks({ facts: [], events }, now);
  const ids = new Set(events.map((e) => e.id));
  const chunkIds = new Set(chunks.map((c) => c.id));
  const oldEvents = await staleIds(env, 'memory_events', 'archive', ids);
  const oldChunks = await staleIds(env, 'memory_chunks', 'archive', chunkIds);
  await insertEvents(env, events, 'archive');
  await insertChunks(env, chunks, 'archive');
  await deleteIds(env, 'memory_events', oldEvents);
  await deleteIds(env, 'memory_chunks', oldChunks);
  return events.length;
}

/** 从事实里提取一个用于消息回溯的检索词（对象优先）。 */
export function provenanceSearchTerm(fact: Pick<MemoryFact, 'content' | 'object'>): string {
  const raw = (fact.object || fact.content)
    .replace(/^\[[^\]]+\]\s*/, '')
    .replace(/^[^=＝\n]{1,16}[=＝]\s*/, '')
    .trim();
  return raw.replace(/[%_]/g, '').slice(0, 30);
}

/**
 * 为 source_message_ids 为空的事实回填来源消息 ID。
 * 这是近似回溯：用对象/内容在最近消息里找包含该片段的记录，最多 5 条。
 */
export async function backfillMemoryProvenance(env: Env, limit = 80): Promise<number> {
  const rows = await env.DB.prepare(
    `SELECT id, content, object FROM memory_facts
     WHERE source_message_ids IS NULL OR source_message_ids = '[]'
     ORDER BY updated_at DESC
     LIMIT ?`,
  )
    .bind(limit)
    .all<{ id: string; content: string; object: string | null }>();

  let linked = 0;
  for (const fact of rows.results ?? []) {
    const term = provenanceSearchTerm(fact);
    if (term.length < 2) continue;
    const found = await env.DB.prepare(
      `SELECT id FROM messages WHERE instr(content, ?) > 0 ORDER BY id DESC LIMIT 5`,
    )
      .bind(term)
      .all<{ id: number }>();
    const ids = (found.results ?? []).map((r) => r.id);
    if (ids.length === 0) continue;
    await env.DB.prepare(
      `UPDATE memory_facts SET source_message_ids = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(JSON.stringify(ids), Date.now(), fact.id)
      .run();
    linked += 1;
  }
  return linked;
}

export interface MemoryJobStats {
  queued: number;
  running: number;
  done: number;
  failed: number;
}

export async function memoryJobStats(env: Env): Promise<MemoryJobStats> {
  const rows = await env.DB.prepare(
    `SELECT status, COUNT(*) AS c FROM memory_jobs GROUP BY status`,
  ).all<{ status: keyof MemoryJobStats; c: number }>();
  const out: MemoryJobStats = { queued: 0, running: 0, done: 0, failed: 0 };
  for (const r of rows.results ?? []) {
    if (r.status in out) out[r.status] = Number(r.c) || 0;
  }
  return out;
}
