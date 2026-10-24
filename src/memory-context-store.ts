/**
 * Memory Context 的 D1 持久化（Phase 2）。
 *
 * 当前阶段以 memory.md 为唯一导入源：解析 → facts/events/chunks → D1。
 * 旧表 memory_entries / 旧召回路径完全不动，便于影子对比与回滚。
 */
import type { Env } from './types';
import {
  buildMemoryChunks,
  parseMemoryContext,
  type MemoryChunk,
  type MemoryEvent,
  type MemoryFact,
} from './memory-domain';

export interface MemoryContextStats {
  facts: number;
  events: number;
  summaries: number;
  chunks: number;
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

async function deleteIds(env: Env, table: string, ids: string[]): Promise<void> {
  for (const batch of chunksOf(ids)) {
    const placeholders = batch.map(() => '?').join(',');
    await env.DB.prepare(`DELETE FROM ${table} WHERE id IN (${placeholders})`)
      .bind(...batch)
      .run();
  }
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
  const chunks = buildMemoryChunks(parsed, now);

  const factIds = new Set(parsed.facts.map((f) => f.id));
  const eventIds = new Set(parsed.events.map((e) => e.id));
  const chunkIds = new Set(chunks.map((c) => c.id));

  const oldFacts = await staleIds(env, 'memory_facts', origin, factIds);
  const oldEvents = await staleIds(env, 'memory_events', origin, eventIds);
  const oldChunks = await staleIds(env, 'memory_chunks', origin, chunkIds);

  await insertFacts(env, parsed.facts, origin);
  await insertEvents(env, parsed.events, origin);
  await insertChunks(env, chunks, origin);

  await deleteIds(env, 'memory_facts', oldFacts);
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

export async function memoryContextStats(env: Env): Promise<MemoryContextStats> {
  const row = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM memory_facts) AS facts,
       (SELECT COUNT(*) FROM memory_events) AS events,
       (SELECT COUNT(*) FROM memory_summaries) AS summaries,
       (SELECT COUNT(*) FROM memory_chunks) AS chunks`,
  ).first<{ facts: number; events: number; summaries: number; chunks: number }>();
  return {
    facts: Number(row?.facts) || 0,
    events: Number(row?.events) || 0,
    summaries: Number(row?.summaries) || 0,
    chunks: Number(row?.chunks) || 0,
  };
}
