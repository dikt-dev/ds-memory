/**
 * 记忆之间的显式关联。
 *
 * 借鉴 LRC 的“记录层关联”思路，但不引入本地服务：
 * - 同实体：共享具体 tag；
 * - 同事件：事实日期与 event.date_key 相同；
 * - 关联只从已召回结果做有界扩展，不扩张召回根集。
 * @unwired 未接线（2026-11-08）：memory_links 只服务召回扩展（expandLinkedChunks），
 *          而召回在覆盖率短路下几乎不执行扩展。已停止夜间自动维护。
 */
import type { Env } from './types';
import { stableHash, type MemoryChunk, type MemoryFact } from './memory-domain';

const GENERIC_TAGS = new Set([
  '用户',
  '近况',
  '状态',
  '喜好',
  '偏好',
  '工作',
  '生活',
  '记忆',
  '日常',
]);

interface LinkRow {
  from_type: 'fact' | 'event';
  from_id: string;
  to_type: 'fact' | 'event';
  to_id: string;
  relation: string;
  confidence: number;
  source: string;
}

interface ChunkRow {
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
}

function parseArray<T>(raw: string | null | undefined): T[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? (arr as T[]) : [];
  } catch {
    return [];
  }
}

function specificTag(tags: string[]): string | null {
  return (
    tags.find(
      (t) => t.trim().length >= 2 && t.trim().length <= 24 && !GENERIC_TAGS.has(t.trim()),
    ) ?? null
  );
}

function linkId(fromType: string, fromId: string, toType: string, toId: string): string {
  return `link_${stableHash(`${fromType}|${fromId}|${toType}|${toId}`)}`;
}

async function insertLink(env: Env, link: LinkRow): Promise<void> {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO memory_links
     (id, from_type, from_id, to_type, to_id, relation, confidence, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      linkId(link.from_type, link.from_id, link.to_type, link.to_id),
      link.from_type,
      link.from_id,
      link.to_type,
      link.to_id,
      link.relation,
      link.confidence,
      link.source,
      Date.now(),
    )
    .run();
}

/** 为一新事实建立同实体/同事件关联；失败不影响主流程。 */
export async function linkFactToNeighbors(env: Env, fact: MemoryFact): Promise<number> {
  const tag = specificTag(fact.tags);
  let linked = 0;

  if (tag) {
    const rows = await env.DB.prepare(
      `SELECT id FROM memory_facts
       WHERE id <> ? AND tags LIKE ?
       ORDER BY updated_at DESC LIMIT 5`,
    )
      .bind(fact.id, `%${tag}%`)
      .all<{ id: string }>();
    for (const row of rows.results ?? []) {
      await insertLink(env, {
        from_type: 'fact',
        from_id: fact.id,
        to_type: 'fact',
        to_id: row.id,
        relation: 'same_entity',
        confidence: 0.65,
        source: `auto:tag:${tag}`,
      });
      linked += 1;
    }
  }

  if (fact.validFrom) {
    const rows = await env.DB.prepare(
      `SELECT id FROM memory_events
       WHERE date_key = ? ORDER BY created_at DESC LIMIT 3`,
    )
      .bind(fact.validFrom)
      .all<{ id: string }>();
    for (const row of rows.results ?? []) {
      await insertLink(env, {
        from_type: 'fact',
        from_id: fact.id,
        to_type: 'event',
        to_id: row.id,
        relation: 'same_event',
        confidence: 0.55,
        source: 'auto:date',
      });
      linked += 1;
    }
  }

  return linked;
}

/** 初始化/重建后补齐现有事实的关联。 */
export async function linkAllFacts(env: Env): Promise<number> {
  const rows = await env.DB.prepare(
    `SELECT id, section, content, subject, predicate, object, valid_from, valid_to,
            confidence, source_message_ids, tags, content_hash, created_at, updated_at
     FROM memory_facts ORDER BY updated_at ASC LIMIT 1000`,
  ).all<{
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

  let linked = 0;
  for (const r of rows.results ?? []) {
    linked += await linkFactToNeighbors(env, {
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
    });
  }
  return linked;
}

function chunkFromRow(r: ChunkRow): MemoryChunk {
  return {
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
  };
}

/**
 * 从已召回的 chunk 出发，取最多 limit 个直接关联 chunk。
 * 只做 1 跳；不改变根集，不递归扩散。
 */
/**
 * 关联扩展的预算：只有她挑得不够多时才补。
 *
 * 实测（10-30）：选择器挑中 1 条最准的，扩展又给回 2 条相关但不那么准的，
 * 最终 1 → 3 条。P1-1b 的目标是「少而准」，挑够了还扩等于把它稀释回去。
 */
export function expansionBudget(pickedCount: number, cap = 2, minPicked = 2): number {
  return pickedCount > 0 && pickedCount < minPicked ? cap : 0;
}

export async function expandLinkedChunks(
  env: Env,
  roots: MemoryChunk[],
  limit = 2,
): Promise<MemoryChunk[]> {
  if (roots.length === 0 || limit <= 0) return roots;

  const seen = new Set(roots.map((c) => c.id));
  const extra: MemoryChunk[] = [];

  for (const root of roots) {
    if (extra.length >= limit) break;
    if (root.source !== 'fact' && root.source !== 'event') continue;

    const links = await env.DB.prepare(
      `SELECT from_type, from_id, to_type, to_id, relation, confidence, source
       FROM memory_links
       WHERE (from_type = ? AND from_id = ?) OR (to_type = ? AND to_id = ?)
       ORDER BY confidence DESC, created_at DESC
       LIMIT 8`,
    )
      .bind(root.source, root.sourceId, root.source, root.sourceId)
      .all<LinkRow>();

    for (const link of links.results ?? []) {
      if (extra.length >= limit) break;
      const targetType =
        link.from_type === root.source && link.from_id === root.sourceId
          ? link.to_type
          : link.from_type;
      const targetId =
        link.from_type === root.source && link.from_id === root.sourceId
          ? link.to_id
          : link.from_id;
      if (targetType !== 'fact' && targetType !== 'event') continue;

      const row = await env.DB.prepare(
        `SELECT id, source, source_id, section, content, date, keywords, tags,
                importance, vec, content_hash, updated_at
         FROM memory_chunks WHERE source = ? AND source_id = ? LIMIT 1`,
      )
        .bind(targetType, targetId)
        .first<ChunkRow>();
      if (!row || seen.has(row.id)) continue;
      seen.add(row.id);
      extra.push(chunkFromRow(row));
    }
  }

  return [...roots, ...extra];
}

/** 来源追溯：某条记忆的直接关联、两端内容和来源消息 id。 */
export async function linksForMemory(
  env: Env,
  type: 'fact' | 'event',
  id: string,
): Promise<{
  links: LinkRow[];
  nodes: Array<{ type: string; id: string; content: string; sourceMessageIds: number[] }>;
}> {
  const links = await env.DB.prepare(
    `SELECT from_type, from_id, to_type, to_id, relation, confidence, source
     FROM memory_links
     WHERE (from_type = ? AND from_id = ?) OR (to_type = ? AND to_id = ?)
     ORDER BY confidence DESC, created_at DESC LIMIT 30`,
  )
    .bind(type, id, type, id)
    .all<LinkRow>();

  const nodes: Array<{ type: string; id: string; content: string; sourceMessageIds: number[] }> = [];
  const seen = new Set<string>();
  const addNode = async (nodeType: string, nodeId: string) => {
    const key = `${nodeType}:${nodeId}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (nodeType === 'fact') {
      const row = await env.DB.prepare(
        'SELECT content, source_message_ids FROM memory_facts WHERE id = ? LIMIT 1',
      )
        .bind(nodeId)
        .first<{ content: string; source_message_ids: string }>();
      if (row) {
        nodes.push({
          type: nodeType,
          id: nodeId,
          content: row.content,
          sourceMessageIds: parseArray<number>(row.source_message_ids),
        });
      }
    } else if (nodeType === 'event') {
      const row = await env.DB.prepare(
        'SELECT summary, source_message_ids FROM memory_events WHERE id = ? LIMIT 1',
      )
        .bind(nodeId)
        .first<{ summary: string; source_message_ids: string }>();
      if (row) {
        nodes.push({
          type: nodeType,
          id: nodeId,
          content: row.summary,
          sourceMessageIds: parseArray<number>(row.source_message_ids),
        });
      }
    }
  };

  await addNode(type, id);
  for (const link of links.results ?? []) {
    await addNode(link.from_type, link.from_id);
    await addNode(link.to_type, link.to_id);
  }
  return { links: links.results ?? [], nodes };
}
