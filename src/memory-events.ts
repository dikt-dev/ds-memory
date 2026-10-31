/**
 * 事件级记忆 v2 —— 阶段 A：影子写入（只写不读）。
 *
 * 设计见 docs/memory/memory-architecture-v2.md。
 * 这里只做三件事：把消息切成事件、让模型产出结构化事件、幂等落库。
 * **读路径完全没动**，所以出问题只要删表或停 cron，线上行为不变。
 */
import type { Env } from './types';
import { assertAllowed } from './policy';
import { quoteGate } from './fact-confidence';
import { distillText } from './distill';
import { addLlmCost } from './llm-cost';
import { dateKeyInBeijing } from './date';

/** 间隔超过这个时长就强制切事件。 */
export const EVENT_GAP_MS = 45 * 60 * 1000;
/** 单个事件最多包含多少条消息（防止一次聊几小时的流水账）。 */
export const EVENT_MAX_MESSAGES = 40;
/** 每个事件最多保留几条逐字引文。 */
export const EVENT_MAX_QUOTES = 3;

export interface EventSourceRow {
  id: number;
  role: string;
  content: string;
  created_ms: number;
  turn_type?: string | null;
}

export interface MemoryEvent {
  date_key: string;
  started_ms: number;
  ended_ms: number;
  title: string;
  summary: string;
  /** 逐字引文（必须能在原文里原样找到） */
  quotes: string[];
  msg_ids: number[];
  entities: string[];
  facts: string[];
  importance: number;
}

let ensured = false;

/**
 * ★ 表名必须是 `memory_event_log`，不能叫 `memory_events`。
 *   `memory_events` 早就被 schema.sql 占用了，那是**记忆上下文投影**（id TEXT/section/summary/participants…），
 *   和这里的事件账本（started_ms/ended_ms/title/quotes…）是两套完全不同的结构。
 *   曾用同名导致线上 `CREATE TABLE IF NOT EXISTS` 被跳过、`CREATE UNIQUE INDEX … (started_ms, ended_ms)`
 *   报 `no such column: started_ms`，整个回填接口 500，阶段 A 从未写入成功（2026-10-31 修复）。
 */
export async function ensureEventsTable(env: Env): Promise<void> {
  if (ensured) return;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS memory_event_log (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       date_key TEXT NOT NULL,
       started_ms INTEGER NOT NULL,
       ended_ms INTEGER NOT NULL,
       title TEXT NOT NULL,
       summary TEXT NOT NULL,
       quotes TEXT NOT NULL,
       msg_ids TEXT NOT NULL,
       entities TEXT NOT NULL,
       facts TEXT NOT NULL,
       importance INTEGER NOT NULL DEFAULT 3,
       status TEXT NOT NULL DEFAULT "active",
       superseded_by INTEGER,
       created_at INTEGER NOT NULL
     )`,
  ).run();
  await env.DB.prepare(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_event_log_range ON memory_event_log(started_ms, ended_ms)`).run();
  ensured = true;
}

/** 按时间间隔与条数把消息切成事件（纯函数）。 */
export function segmentEvents(rows: EventSourceRow[]): EventSourceRow[][] {
  const sorted = [...rows].sort((a, b) => a.created_ms - b.created_ms || a.id - b.id);
  const out: EventSourceRow[][] = [];
  let cur: EventSourceRow[] = [];
  for (const row of sorted) {
    const prev = cur[cur.length - 1];
    const gapBreak = prev ? row.created_ms - prev.created_ms > EVENT_GAP_MS : false;
    const sizeBreak = cur.length >= EVENT_MAX_MESSAGES;
    if (cur.length > 0 && (gapBreak || sizeBreak)) {
      out.push(cur);
      cur = [];
    }
    cur.push(row);
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

/** 引文必须能在原文里原样找到；找不到就丢掉（防模型改写）。 */
export function validateQuotes(quotes: string[], rows: EventSourceRow[]): string[] {
  const pool = rows.map((r) => r.content);
  const out: string[] = [];
  for (const q of quotes) {
    const text = (q ?? "").trim();
    if (!text || text.length < 4) continue;
    if (!pool.some((c) => c.includes(text))) continue;
    if (!out.includes(text)) out.push(text);
  }
  return out.slice(0, EVENT_MAX_QUOTES);
}
const EVENT_SYSTEM = [
  "你在做记忆归档：把一段对话整理成一个「事件」。",
  "严格输出 JSON，不要 markdown 代码块，不要解释：",
  '{"title":"≤20字","summary":"≤120字，写发生了什么和结论","quotes":["逐字原句"],"entities":["人名/项目/地点/偏好"],"facts":["≤30字的结论事实"],"importance":1}',
  "要求：",
  "1. quotes 必须是对话里**原样出现**的句子（直接复制，不许改写、不许合并、不许加标点），1~3 条；",
  "2. summary 概括这段发生了什么，不要评价；",
  "3. facts 只写之后可能被问到的结论，0~3 条；",
  "4. entities 只写专有名词（人名、项目、城市、食物、作品名）；",
  "5. importance 1~5，5=重要决定/情绪事件，1=日常寒暄。",
].join("\n");

/** 从模型输出里取出 JSON（容忍代码块包裹）。 */
export function parseEventJson(text: string): Record<string, unknown> | null {
  if (!text) return null;
  const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function strList(value: unknown, max: number, maxLen: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const text = item.trim();
    if (!text) continue;
    out.push(text.slice(0, maxLen));
    if (out.length >= max) break;
  }
  return out;
}

function buildEventInput(rows: EventSourceRow[]): string {
  return rows
    .map((r) => {
      const who = r.role === "user" ? "用户" : r.turn_type === "proactive" ? "她（主动）" : "她";
      return who + "：" + r.content.replace(/\s+/g, " ");
    })
    .join("\n");
}

/** 让模型把一个事件块整理成结构化事件。 */
export async function extractEvent(env: Env, rows: EventSourceRow[]): Promise<MemoryEvent | null> {
  if (rows.length === 0) return null;
  const input = buildEventInput(rows);
  const result = await distillText(
    env,
    EVENT_SYSTEM,
    input,
    800,
    env.SUMMARY_DEEPSEEK_MODEL || env.DEEPSEEK_MODEL,
  );
  await addLlmCost(env, dateKeyInBeijing(new Date(rows[rows.length - 1].created_ms)), result.cost);
  const parsed = parseEventJson(result.text);
  if (!parsed) return null;
  const title = typeof parsed.title === "string" ? parsed.title.trim().slice(0, 20) : "";
  const summary = typeof parsed.summary === "string" ? parsed.summary.trim().slice(0, 120) : "";
  if (!title || !summary) return null;
  const proposedQuotes = strList(parsed.quotes, EVENT_MAX_QUOTES, 200);
  const gate = quoteGate(proposedQuotes, validateQuotes(proposedQuotes, rows));
  // 一句都对不上 = 这条事件是编的：宁可少记一件，也不许把编的留在记忆里。
  if (!gate.ok) return null;
  const importanceRaw = Number(parsed.importance ?? 3);
  const importance = Number.isFinite(importanceRaw) ? Math.min(5, Math.max(1, Math.round(importanceRaw))) : 3;
  return {
    date_key: dateKeyInBeijing(new Date(rows[0].created_ms)),
    started_ms: rows[0].created_ms,
    ended_ms: rows[rows.length - 1].created_ms,
    title,
    summary,
    quotes: gate.kept,
    msg_ids: rows.map((r) => r.id),
    entities: strList(parsed.entities, 8, 20),
    facts: strList(parsed.facts, 3, 30),
    importance,
  };
}

/** 幂等写入：同一个 (started_ms, ended_ms) 覆盖更新。 */
export async function writeEvent(env: Env, ev: MemoryEvent): Promise<void> {
  // 不变量 4：事件必须能指回它断言的那几条消息，否则不许入库。
  assertAllowed(
    { kind: 'event.write', sourceMessageIds: ev.msg_ids },
    { actor: 'job' },
  );
  await ensureEventsTable(env);
  await env.DB.prepare(
    `INSERT INTO memory_event_log
       (date_key, started_ms, ended_ms, title, summary, quotes, msg_ids, entities, facts, importance, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, "active", ?)
     ON CONFLICT(started_ms, ended_ms) DO UPDATE SET
       title = excluded.title,
       summary = excluded.summary,
       quotes = excluded.quotes,
       msg_ids = excluded.msg_ids,
       entities = excluded.entities,
       facts = excluded.facts,
       importance = excluded.importance`,
  )
    .bind(
      ev.date_key,
      ev.started_ms,
      ev.ended_ms,
      ev.title,
      ev.summary,
      JSON.stringify(ev.quotes),
      JSON.stringify(ev.msg_ids),
      JSON.stringify(ev.entities),
      JSON.stringify(ev.facts),
      ev.importance,
      Date.now(),
    )
    .run();
}

export interface BackfillResult {
  days: number;
  scanned: number;
  saved: number;
  failed: number;
  skipped: number;
}

/**
 * 影子回填：把最近 N 天的对话整理成事件写进 memory_events。
 * 只写不读，失败不影响聊天；同一区间重跑会覆盖，不会重复。
 */
export async function backfillEvents(
  env: Env,
  opts: { days?: number; maxEvents?: number; now?: Date } = {},
): Promise<BackfillResult> {
  const days = Math.min(30, Math.max(1, Math.floor(opts.days ?? 3)));
  const maxEvents = Math.max(1, Math.floor(opts.maxEvents ?? 30));
  const now = opts.now ?? new Date();
  await ensureEventsTable(env);
  const result: BackfillResult = { days, scanned: 0, saved: 0, failed: 0, skipped: 0 };
  for (let back = days - 1; back >= 0; back--) {
    if (result.saved >= maxEvents) break;
    const day = dateKeyInBeijing(new Date(now.getTime() - back * 86400000));
    let rows: EventSourceRow[] = [];
    try {
      const res = await env.DB.prepare(
        `SELECT id, role, content, created_ms, turn_type FROM messages
         WHERE date_key = ? ORDER BY created_ms ASC, id ASC
         LIMIT 2000`,
      )
        .bind(day)
        .all<EventSourceRow>();
      rows = res.results ?? [];
    } catch {
      continue;
    }
    result.scanned += rows.length;
    for (const chunk of segmentEvents(rows)) {
      if (result.saved >= maxEvents) break;
      try {
        const ev = await extractEvent(env, chunk);
        if (!ev) {
          result.skipped += 1;
          continue;
        }
        await writeEvent(env, ev);
        result.saved += 1;
      } catch {
        result.failed += 1;
      }
    }
  }
  return result;
}

export interface EventStats {
  total: number;
  withQuotes: number;
  days: number;
  avgImportance: number;
}

/** 看一眼影子数据攒得怎么样（只读）。 */
export async function readEventStats(env: Env, days = 7): Promise<EventStats> {
  try {
    await ensureEventsTable(env);
    const cutoff = dateKeyInBeijing(new Date(Date.now() - Math.max(1, days) * 86400000));
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS total,
              COUNT(DISTINCT date_key) AS days,
              ROUND(AVG(importance), 2) AS avg_importance,
              SUM(CASE WHEN quotes != "[]" THEN 1 ELSE 0 END) AS with_quotes
       FROM memory_event_log WHERE date_key >= ?`,
    )
      .bind(cutoff)
      .first<{ total: number; days: number; avg_importance: number | null; with_quotes: number | null }>();
    return {
      total: row?.total ?? 0,
      days: row?.days ?? 0,
      withQuotes: row?.with_quotes ?? 0,
      avgImportance: row?.avg_importance ?? 0,
    };
  } catch {
    return { total: 0, days: 0, withQuotes: 0, avgImportance: 0 };
  }
}
