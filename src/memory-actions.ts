/**
 * 自主动作审计（ADR-001 S2）。
 *
 * 她可以自己决定记什么、怎么记，但每一笔都必须留下：
 * 谁做的、哪一档、为什么、依据什么、改了什么、能不能撤。
 * 没有这张表，出问题时只能看到她"突然变了"。
 */
import type { Env } from './types';
import { tierOf, type ActionKind, type Actor, type PolicyTier } from './policy';

export interface ActionRecord {
  id?: number;
  actor: Actor;
  tier: PolicyTier;
  kind: ActionKind;
  /** 为什么做（agent 必填，job 可空）。 */
  intent: string;
  /** 依据：消息 id / 指标名 / 样本 id。 */
  evidence: string[];
  /** 改动摘要（人可读的一句话）。 */
  diff: string;
  /** 改动前的值（可为空，按动作类型决定）。 */
  before: string;
  /** 改动后的值。 */
  after: string;
  result: 'ok' | 'failed' | 'reverted';
  /** 能否撤销；不能撤销的动作必须在这里写清楚原因。 */
  revertible: boolean;
  created_at?: number;
}

export const ACTIONS_TABLE = 'memory_actions';

const MAX_TEXT = 4000;

function clipText(value: string | undefined): string {
  const s = (value ?? '').trim();
  return s.length <= MAX_TEXT ? s : s.slice(0, MAX_TEXT) + '…';
}

/**
 * 入库前的规整与校验：tier 由 policy 决定，调用方不许自己指定——
 * 否则自主动作可以把自己标成 A 档绕过隔离。
 */
export function normalizeAction(
  input: Omit<ActionRecord, 'tier' | 'result' | 'created_at'> & {
    result?: ActionRecord['result'];
    created_at?: number;
  },
  now = Date.now(),
): ActionRecord {
  if (!input.kind) throw new Error('action kind required');
  const tier = tierOf(input.kind);
  if (tier === 'C') throw new Error('action kind ' + input.kind + ' is forbidden by policy');
  return {
    id: input.id,
    actor: input.actor,
    tier,
    kind: input.kind,
    intent: clipText(input.intent),
    evidence: (input.evidence ?? []).map((e) => clipText(String(e))).slice(0, 20),
    diff: clipText(input.diff),
    before: clipText(input.before),
    after: clipText(input.after),
    result: input.result ?? 'ok',
    revertible: input.revertible,
    created_at: input.created_at ?? now,
  };
}

export async function ensureActionsTable(env: Env): Promise<void> {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS memory_actions (
       id         INTEGER PRIMARY KEY AUTOINCREMENT,
       actor      TEXT NOT NULL,
       tier       TEXT NOT NULL,
       kind       TEXT NOT NULL,
       intent     TEXT NOT NULL DEFAULT '',
       evidence   TEXT NOT NULL DEFAULT '[]',
       diff       TEXT NOT NULL DEFAULT '',
       before_v   TEXT NOT NULL DEFAULT '',
       after_v    TEXT NOT NULL DEFAULT '',
       result     TEXT NOT NULL DEFAULT 'ok',
       revertible INTEGER NOT NULL DEFAULT 0,
       reverted_by INTEGER,
       created_at INTEGER NOT NULL
     )`,
  ).run();
  // 审计表按时间倒序查，没索引就是全表扫。
  await env.DB.prepare(
    'CREATE INDEX IF NOT EXISTS idx_memory_actions_created ON memory_actions(created_at)',
  ).run();
}

export async function recordAction(
  env: Env,
  input: Parameters<typeof normalizeAction>[0],
  now = Date.now(),
): Promise<ActionRecord> {
  const action = normalizeAction(input, now);
  await ensureActionsTable(env);
  const res = await env.DB.prepare(
    `INSERT INTO memory_actions
       (actor, tier, kind, intent, evidence, diff, before_v, after_v, result, revertible, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      action.actor,
      action.tier,
      action.kind,
      action.intent,
      JSON.stringify(action.evidence),
      action.diff,
      action.before,
      action.after,
      action.result,
      action.revertible ? 1 : 0,
      action.created_at,
    )
    .run();
  action.id = Number(res?.meta?.last_row_id ?? 0) || undefined;
  return action;
}

export interface ActionRow {
  id: number;
  actor: string;
  tier: string;
  kind: string;
  intent: string;
  evidence: string;
  diff: string;
  before_v: string;
  after_v: string;
  result: string;
  revertible: number;
  reverted_by: number | null;
  created_at: number;
}

export function toActionRecord(row: ActionRow): ActionRecord {
  let evidence: string[] = [];
  try {
    const parsed = JSON.parse(row.evidence || '[]');
    evidence = Array.isArray(parsed) ? parsed.map((x) => String(x)) : [];
  } catch {
    evidence = [];
  }
  return {
    id: row.id,
    actor: row.actor as Actor,
    tier: row.tier as PolicyTier,
    kind: row.kind as ActionKind,
    intent: row.intent,
    evidence,
    diff: row.diff,
    before: row.before_v,
    after: row.after_v,
    result: row.result as ActionRecord['result'],
    revertible: row.revertible === 1,
    created_at: row.created_at,
  };
}

export async function listActions(
  env: Env,
  opts: { limit?: number; kind?: ActionKind } = {},
): Promise<ActionRecord[]> {
  await ensureActionsTable(env);
  const limit = Math.min(200, Math.max(1, Math.floor(opts.limit ?? 50)));
  const sql = opts.kind
    ? 'SELECT * FROM memory_actions WHERE kind = ? ORDER BY id DESC LIMIT ?'
    : 'SELECT * FROM memory_actions ORDER BY id DESC LIMIT ?';
  const stmt = env.DB.prepare(sql);
  const bound = opts.kind ? stmt.bind(opts.kind, limit) : stmt.bind(limit);
  const res = await bound.all<ActionRow>();
  return (res.results ?? []).map(toActionRecord);
}

/** 标记为已撤销（真正回滚由对应动作自己实现，撤销记录必须留痕）。 */
export async function markReverted(
  env: Env,
  id: number,
  revertedBy: number,
): Promise<boolean> {
  await ensureActionsTable(env);
  const res = await env.DB.prepare(
    `UPDATE memory_actions SET result = 'reverted', reverted_by = ?
     WHERE id = ? AND revertible = 1`,
  )
    .bind(revertedBy, id)
    .run();
  return Number(res?.meta?.changes ?? 0) > 0;
}
