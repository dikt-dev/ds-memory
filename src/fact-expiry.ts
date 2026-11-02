/**
 * 事实失效链（ADR-001 S4）。
 *
 * 她会不断记下新事实。没有这一层，"在北京"和"搬到成都"会同时有效，
 * 她就会在两个城市之间漂移——而且没有任何人能手改。
 *
 * 规则：
 * - 同一 (subject, predicate) 出现新事实时，旧事实写 valid_to = 新事实生效时间，保留可查；
 * - 同一事实（object 完全相同）只合并出处，不算冲突、不失效；
 * - 落库前先算计划（纯函数，可测），再统一 UPDATE，避免逐条往返。
 */
import type { Env } from './types';
import type { MemoryFact } from './memory-domain';
import { recordAction } from './memory-actions';

export interface FactKeyRow {
  id: string;
  subject: string | null;
  predicate: string | null;
  object: string | null;
  valid_from: string | null;
  valid_to: string | null;
}

export interface ExpiryStep {
  id: string;
  subject: string;
  predicate: string;
  object: string;
  validTo: string;
  /** 被哪条新事实顶掉（新事实 id）。 */
  supersededBy: string;
}

function norm(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

/** 只有带 subject + predicate 的事实才能参与冲突判定。 */
export function factKey(fact: Pick<MemoryFact, 'subject' | 'predicate'>): string | null {
  const s = norm(fact.subject);
  const p = norm(fact.predicate);
  if (!s || !p) return null;
  return s + '\u0000' + p;
}

/** 生效时间：优先新事实的 validFrom，否则用当下（北京日）。 */
function effectiveAt(fact: MemoryFact, nowIso: string): string {
  const from = (fact.validFrom ?? '').trim();
  return from !== '' ? from : nowIso;
}

/**
 * 算出"哪些旧事实该失效"。
 *
 * @param existing 库里的候选行（调用方按 key 预筛，也可全量传进来）
 * @param incoming 本次要写入的事实
 * @param nowIso   没有 validFrom 时的生效时间
 */
export function planExpiry(
  existing: FactKeyRow[],
  incoming: MemoryFact[],
  nowIso: string,
): ExpiryStep[] {
  const byKey = new Map<string, FactKeyRow[]>();
  for (const row of existing) {
    const key = factKey({ subject: row.subject, predicate: row.predicate });
    if (!key) continue;
    const list = byKey.get(key) ?? [];
    list.push(row);
    byKey.set(key, list);
  }

  const steps: ExpiryStep[] = [];
  const seen = new Set<string>();
  for (const fact of incoming) {
    const key = factKey(fact);
    if (!key) continue;
    const candidates = byKey.get(key) ?? [];
    const validTo = effectiveAt(fact, nowIso);
    for (const row of candidates) {
      if (row.id === fact.id) continue;
      // 已经失效过的不用再动。
      if (row.valid_to && row.valid_to.trim() !== '') continue;
      // 值相同：同一事实重复出现，只合并出处。
      if (norm(row.object) === norm(fact.object)) continue;
      const dedupe = row.id + '\u0000' + fact.id;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      steps.push({
        id: row.id,
        subject: row.subject ?? '',
        predicate: row.predicate ?? '',
        object: row.object ?? '',
        validTo,
        supersededBy: fact.id,
      });
    }
    // 同批次内的旧事实也要参与：把新事实当成"已存在"继续比对。
    byKey.set(key, [
      ...candidates,
      {
        id: fact.id,
        subject: fact.subject,
        predicate: fact.predicate,
        object: fact.object,
        valid_from: fact.validFrom,
        valid_to: fact.validTo,
      },
    ]);
  }
  return steps;
}

/** 按 key 拉候选行（一次查询，避免逐条往返）。 */
export async function loadExpiryCandidates(
  env: Env,
  facts: MemoryFact[],
): Promise<FactKeyRow[]> {
  const subjects = [...new Set(facts.map((f) => (f.subject ?? '').trim()).filter(Boolean))];
  if (subjects.length === 0) return [];
  const placeholders = subjects.map(() => '?').join(',');
  const res = await env.DB.prepare(
    `SELECT id, subject, predicate, object, valid_from, valid_to
     FROM memory_facts
     WHERE lower(subject) IN (${placeholders})
     LIMIT 500`,
  )
    .bind(...subjects.map((s) => s.toLowerCase()))
    .all<FactKeyRow>();
  return res.results ?? [];
}

/** 执行失效：写 valid_to，不删行。 */
export async function applyExpiry(
  env: Env,
  steps: ExpiryStep[],
  nowMs: number,
): Promise<number> {
  if (steps.length === 0) return 0;
  // 一次 batch 发完：逐条 await 在 D1 上是 N 次往返，事实一多就成瓶颈。
  const results = await env.DB.batch(
    steps.map((step) =>
      env.DB.prepare(
        `UPDATE memory_facts SET valid_to = ?, updated_at = ?
         WHERE id = ? AND (valid_to IS NULL OR valid_to = '')`,
      ).bind(step.validTo, nowMs, step.id),
    ),
  );
  return results.reduce((sum, r) => sum + Number((r as { meta?: { changes?: number } })?.meta?.changes ?? 0), 0);
}

/** 给对话抽取的事实补上失效链，并把动作写进审计表。 */
export async function expireSupersededFacts(
  env: Env,
  incoming: MemoryFact[],
  nowMs: number,
  nowIso: string,
): Promise<number> {
  let candidates: FactKeyRow[] = [];
  try {
    candidates = await loadExpiryCandidates(env, incoming);
  } catch {
    // 表还没建好时静默跳过：不能因为失效链失败就把新事实也丢了。
    return 0;
  }
  const steps = planExpiry(candidates, incoming, nowIso);
  const changed = await applyExpiry(env, steps, nowMs);
  if (steps.length > 0) {
    await recordAction(env, {
      actor: 'job',
      kind: 'fact.expire',
      intent: '同一 subject+predicate 出现新值，旧事实置为失效（保留可查）',
      evidence: steps.map((s) => 'fact:' + s.supersededBy),
      diff: steps
        .map((s) => `${s.id} (${s.subject}=${s.object}) valid_to=${s.validTo}`)
        .join('; ')
        .slice(0, 2000),
      before: `${steps.length} 条事实 valid_to=NULL`,
      after: `${changed} 条已失效`,
      revertible: true,
    }, nowMs);
  }
  return changed;
}


export interface FactMergeRow extends FactKeyRow {
  source_message_ids?: string | null;
  confidence?: number | null;
}

export interface IdenticalMerge {
  id: string;
  sourceMessageIds: number[];
  confidence: number;
  validFrom: string | null;
  updatedAt: number;
}

function parseIds(raw: string | null | undefined): number[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as unknown;
    return Array.isArray(arr) ? arr.filter((x): x is number => typeof x === 'number' && Number.isFinite(x)) : [];
  } catch {
    return [];
  }
}

/**
 * 「同一事实只留一条」的合并计划。
 *
 * 冲突（object 不同）走 planExpiry；这里管重复（object 完全相同）：
 * 不出新行，把出处并到已有那条上，置信度取高的，valid_from 取更早的。
 */
export function planIdenticalMerges(
  existing: FactMergeRow[],
  incoming: MemoryFact[],
  nowMs: number,
): { updates: IdenticalMerge[]; skip: string[] } {
  const index = new Map<string, FactMergeRow>();
  for (const row of existing) {
    const key = factKey({ subject: row.subject, predicate: row.predicate });
    if (!key) continue;
    if (row.valid_to && row.valid_to.trim() !== '') continue;
    index.set(key + '\u0001' + norm(row.object), row);
  }
  const updates: IdenticalMerge[] = [];
  const skip: string[] = [];
  const merged = new Map<string, IdenticalMerge>();
  for (const fact of incoming) {
    const key = factKey(fact);
    if (!key) continue;
    const row = index.get(key + '\u0001' + norm(fact.object));
    if (!row || row.id === fact.id) continue;
    const prev = merged.get(row.id);
    const ids = new Set([...(prev?.sourceMessageIds ?? parseIds(row.source_message_ids)), ...(fact.sourceMessageIds ?? [])]);
    const validFrom = prev?.validFrom ?? row.valid_from ?? fact.validFrom;
    merged.set(row.id, {
      id: row.id,
      sourceMessageIds: [...ids],
      confidence: Math.max(prev?.confidence ?? row.confidence ?? 0, fact.confidence ?? 0),
      validFrom: validFrom && fact.validFrom && fact.validFrom < validFrom ? fact.validFrom : validFrom,
      updatedAt: nowMs,
    });
    skip.push(fact.id);
  }
  return { updates: [...merged.values()], skip };
}

/** 拉同 subject 的现有事实（含出处与置信度），给合并用。 */
export async function loadMergeCandidates(env: Env, facts: MemoryFact[]): Promise<FactMergeRow[]> {
  const subjects = [...new Set(facts.map((f) => (f.subject ?? '').trim()).filter(Boolean))];
  if (subjects.length === 0) return [];
  const placeholders = subjects.map(() => '?').join(',');
  const res = await env.DB.prepare(
    `SELECT id, subject, predicate, object, valid_from, valid_to, source_message_ids, confidence
     FROM memory_facts
     WHERE lower(subject) IN (${placeholders})
     LIMIT 500`,
  )
    .bind(...subjects.map((s) => s.toLowerCase()))
    .all<FactMergeRow>();
  return res.results ?? [];
}

/**
 * 落库前把「同一条事实」并进已有行，返回应当跳过插入的 id。
 * 失败时返回空集合：宁可多一条重复，也不能把新事实丢了。
 */
export async function dedupeIdenticalFacts(
  env: Env,
  incoming: MemoryFact[],
  nowMs: number,
): Promise<Set<string>> {
  if (incoming.length === 0) return new Set();
  let candidates: FactMergeRow[] = [];
  try {
    candidates = await loadMergeCandidates(env, incoming);
  } catch {
    return new Set();
  }
  const { updates, skip } = planIdenticalMerges(candidates, incoming, nowMs);
  if (updates.length > 0) {
    await env.DB.batch(
      updates.map((u) =>
        env.DB.prepare(
          `UPDATE memory_facts
           SET source_message_ids = ?, confidence = ?, valid_from = ?, updated_at = ?
           WHERE id = ?`,
        ).bind(JSON.stringify(u.sourceMessageIds), u.confidence, u.validFrom, u.updatedAt, u.id),
      ),
    );
  }
  return new Set(skip);
}
