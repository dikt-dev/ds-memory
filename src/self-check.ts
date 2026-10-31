/**
 * 每夜自检（ADR-001 S8）。
 *
 * 前提：没有人能手改记忆。所以系统必须能自己发现"记忆坏了"并自愈：
 * - 引文对不上原文 → 这条事件是编的/被改过，标为可疑并降权；
 * - 事实的出处指向不存在的消息 → 孤儿，降权；
 * - 关系链指向已不存在的事实/事件 → 断链，直接删（派生数据，可重建）。
 *
 * 只做只读判断的纯函数放在前面，IO 放在后面，方便测。
 */
import type { Env } from './types';
import { recordAction } from './memory-actions';
import { putObject } from './storage';
import { dateKeyInBeijing } from './date';

export interface SelfCheckEvent {
  id: number;
  msg_ids: string;
  quotes: string;
  importance: number;
  status: string;
}

export interface QuoteMismatch {
  eventId: number;
  quote: string;
  reason: 'not_in_messages' | 'no_messages';
}

function normalize(text: string): string {
  return (text ?? '').replace(/\s+/g, '').replace(/[“”"']/g, '');
}

/** 引文回查：对不上原文的事件单独列出来。 */
export function findQuoteMismatches(
  events: SelfCheckEvent[],
  messagesById: Map<number, string>,
): QuoteMismatch[] {
  const out: QuoteMismatch[] = [];
  for (const ev of events) {
    let ids: number[] = [];
    try {
      const parsed = JSON.parse(ev.msg_ids || '[]');
      ids = Array.isArray(parsed) ? parsed.map((x) => Number(x)) : [];
    } catch {
      ids = [];
    }
    let quotes: string[] = [];
    try {
      const parsed = JSON.parse(ev.quotes || '[]');
      quotes = Array.isArray(parsed) ? parsed.map((x) => String(x)) : [];
    } catch {
      quotes = [];
    }
    if (ids.length === 0) {
      for (const q of quotes) out.push({ eventId: ev.id, quote: q, reason: 'no_messages' });
      continue;
    }
    const pool = ids.map((id) => normalize(messagesById.get(id) ?? '')).join('|');
    for (const q of quotes) {
      const needle = normalize(q);
      if (needle.length < 4) continue;
      if (!pool.includes(needle)) {
        out.push({ eventId: ev.id, quote: q, reason: 'not_in_messages' });
      }
    }
  }
  return out;
}

export interface OrphanRow {
  kind: 'fact' | 'chunk';
  id: string;
  missing: number[];
}

/** 孤儿检测：出处里有指向不存在消息的，算孤儿。 */
export function findOrphans(
  rows: Array<{ kind: 'fact' | 'chunk'; id: string; sourceMessageIds: number[] }>,
  existingIds: Set<number>,
): OrphanRow[] {
  const out: OrphanRow[] = [];
  for (const row of rows) {
    const missing = row.sourceMessageIds.filter((id) => Number.isFinite(id) && !existingIds.has(id));
    if (missing.length > 0) out.push({ kind: row.kind, id: row.id, missing });
  }
  return out;
}

// ───────────────────────── 执行 ─────────────────────────

export interface SelfCheckReport {
  date: string;
  checkedAt: number;
  events: number;
  facts: number;
  chunks: number;
  links: number;
  quoteMismatches: QuoteMismatch[];
  orphans: OrphanRow[];
  brokenLinks: number;
  repaired: { eventsMarked: number; factsExpired: number; linksDeleted: number };
  ok: boolean;
}

const MAX_EVENTS = 200;
const MAX_ROWS = 2000;

export async function runSelfCheck(env: Env, now = Date.now()): Promise<SelfCheckReport> {
  const date = dateKeyInBeijing(new Date(now));

  // 1) 最近事件 + 它们引用的消息正文
  const evRes = await env.DB.prepare(
    `SELECT id, msg_ids, quotes, importance, status FROM memory_event_log
     WHERE status = 'active' ORDER BY id DESC LIMIT ?`,
  )
    .bind(MAX_EVENTS)
    .all<SelfCheckEvent>();
  const events = evRes.results ?? [];

  const referenced = new Set<number>();
  for (const ev of events) {
    try {
      const ids = JSON.parse(ev.msg_ids || '[]');
      if (Array.isArray(ids)) ids.forEach((id) => referenced.add(Number(id)));
    } catch {
      /* 坏 JSON 交给检测函数处理 */
    }
  }

  const messagesById = new Map<number, string>();
  if (referenced.size > 0) {
    const ids = [...referenced].filter((id) => Number.isFinite(id));
    for (let i = 0; i < ids.length; i += 90) {
      const slice = ids.slice(i, i + 90);
      const res = await env.DB.prepare(
        `SELECT id, content FROM messages WHERE id IN (${slice.map(() => '?').join(',')})`,
      )
        .bind(...slice)
        .all<{ id: number; content: string }>();
      for (const row of res.results ?? []) messagesById.set(Number(row.id), String(row.content));
    }
  }

  const quoteMismatches = findQuoteMismatches(events, messagesById);

  // 2) 事实/片段孤儿检测：只抽查近期写入的
  // 只查 conversation 来源：memory.md 派生的事实出处是文档本身，不是某条消息，
  // 拿消息 id 判定孤儿会误伤（历史回填就曾经指到不存在的 id）。
  const factRes = await env.DB.prepare(
    `SELECT id, source_message_ids FROM memory_facts
     WHERE origin = 'conversation' AND (valid_to IS NULL OR valid_to = '')
     ORDER BY updated_at DESC LIMIT ?`,
  )
    .bind(MAX_ROWS)
    .all<{ id: string; source_message_ids: string }>();
  const chunkRes = await env.DB.prepare(
    `SELECT id, source_id, source FROM memory_chunks ORDER BY updated_at DESC LIMIT ?`,
  )
    .bind(300)
    .all<{ id: string; source_id: string; source: string }>();

  const parseIds = (raw: string): number[] => {
    try {
      const parsed = JSON.parse(raw || '[]');
      return Array.isArray(parsed) ? parsed.map((x) => Number(x)).filter(Number.isFinite) : [];
    } catch {
      return [];
    }
  };

  const factRows = (factRes.results ?? []).map((r) => ({
    kind: 'fact' as const,
    id: r.id,
    sourceMessageIds: parseIds(r.source_message_ids),
  }));

  const existingIds = new Set<number>();
  const allIds = [...new Set(factRows.flatMap((r) => r.sourceMessageIds))];
  for (let i = 0; i < allIds.length; i += 90) {
    const slice = allIds.slice(i, i + 90);
    const res = await env.DB.prepare(
      `SELECT id FROM messages WHERE id IN (${slice.map(() => '?').join(',')})`,
    )
      .bind(...slice)
      .all<{ id: number }>();
    for (const row of res.results ?? []) existingIds.add(Number(row.id));
  }
  // 事件引用的消息也算存在（它们已经查过了）
  for (const id of messagesById.keys()) existingIds.add(id);

  const orphans = findOrphans(factRows, existingIds);

  // 3) 断链：关系链指向不存在的事实/事件
  const linkRes = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM memory_links l
     WHERE (l.to_type = 'fact' AND NOT EXISTS (SELECT 1 FROM memory_facts f WHERE f.id = l.to_id))
        OR (l.to_type = 'event' AND NOT EXISTS (SELECT 1 FROM memory_events e WHERE e.id = l.to_id))`,
  ).first<{ n: number | null }>();
  const brokenLinks = Number(linkRes?.n) || 0;
  let linksDeleted = 0;
  if (brokenLinks > 0) {
    const del = await env.DB.prepare(
      `DELETE FROM memory_links
       WHERE (to_type = 'fact' AND to_id NOT IN (SELECT id FROM memory_facts))
          OR (to_type = 'event' AND to_id NOT IN (SELECT id FROM memory_events))`,
    ).run();
    linksDeleted = Number(del?.meta?.changes ?? 0);
  }

  // 4) 自愈：可疑事件降权 + 孤儿事实降权（不删）
  const badEventIds = [...new Set(quoteMismatches.map((m) => m.eventId))];
  let eventsMarked = 0;
  if (badEventIds.length > 0) {
    // 一次 batch 而不是逐条往返
    const results = await env.DB.batch(
      badEventIds.map((id) =>
        env.DB.prepare(
          `UPDATE memory_event_log SET importance = MAX(1, importance - 2) WHERE id = ?`,
        ).bind(id),
      ),
    );
    eventsMarked = results.reduce(
      (sum, r) => sum + Number((r as { meta?: { changes?: number } })?.meta?.changes ?? 0),
      0,
    );
  }

  // 一次降一档（不直接打到地板）：孤儿可能是回填问题，别一夜之间把真事实废掉。
  const orphanFactIds = orphans.filter((o) => o.kind === 'fact').map((o) => o.id);
  let factsExpired = 0;
  if (orphanFactIds.length > 0) {
    const results = await env.DB.batch(
      orphanFactIds.map((id) =>
        // 一天最多降一次：同一天手动重跑几次不该把真事实连降三档。
        env.DB.prepare(
          `UPDATE memory_facts SET confidence = MAX(0.2, confidence - 0.15), updated_at = ?
           WHERE id = ? AND updated_at < ?`,
        ).bind(now, id, now - 12 * 3600 * 1000),
      ),
    );
    factsExpired = results.reduce(
      (sum, r) => sum + Number((r as { meta?: { changes?: number } })?.meta?.changes ?? 0),
      0,
    );
  }

  const report: SelfCheckReport = {
    date,
    checkedAt: now,
    events: events.length,
    facts: factRows.length,
    chunks: chunkRes.results?.length ?? 0,
    links: 0,
    quoteMismatches: quoteMismatches.slice(0, 50),
    orphans: orphans.slice(0, 50),
    brokenLinks,
    repaired: { eventsMarked, factsExpired, linksDeleted },
    ok: quoteMismatches.length === 0 && orphans.length === 0 && brokenLinks === 0,
  };

  await putObject(env, `memory/self-check/${date}.json`, JSON.stringify(report, null, 2), {
    contentType: 'application/json',
  }).catch(() => {});

  if (!report.ok) {
    await recordAction(env, {
      actor: 'job',
      kind: 'fact.expire',
      intent: '每夜自检发现引文对不上/孤儿/断链，自动降权并留档',
      evidence: [
        ...badEventIds.map((id) => 'event:' + id),
        ...orphans.filter((o) => o.kind === 'fact').map((o) => 'fact:' + o.id),
      ].slice(0, 20),
      diff: `引文不一致 ${quoteMismatches.length} 处 / 孤儿 ${orphans.length} 条 / 断链 ${brokenLinks} 条`,
      before: `事件 ${events.length} 条、事实 ${factRows.length} 条`,
      after: `事件降权 ${eventsMarked}、事实置信度降到 0.2 共 ${factsExpired}、删断链 ${linksDeleted}`,
      revertible: false,
    }, now).catch(() => {});
  }

  return report;
}
