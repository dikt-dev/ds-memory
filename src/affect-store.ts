/**
 * Affect Context 的 D1 账本（Phase 3）。
 *
 * - affect_events：只追加，不覆盖；情绪事件与关系增量都可追溯；
 * - attitude_snapshots：按需保存态度策略快照，供解释/回放；
 * - 所有写入失败只记录/吞掉，不阻断聊天。
 */
import type { Env } from './types';
import type { EmotionEvent } from './emotion-events';
import type { EmotionVector } from './emotion-vector';
import type { RelationFacets, FacetKey } from './relation-facets';
import { stableHash } from './memory-domain';
import type { AttitudePolicy } from './attitude-policy';

type FacetDelta = Partial<Record<FacetKey, number>>;

export async function recordEmotionEvents(
  env: Env,
  events: EmotionEvent[],
  sourceMessageId?: number,
): Promise<number> {
  if (events.length === 0) return 0;
  try {
    let n = 0;
    for (const e of events) {
      const id = `affect_${stableHash(`${e.type}|${e.at}|${e.evidence}|${e.intensity}`)}`;
      const res = await env.DB.prepare(
        `INSERT OR IGNORE INTO affect_events
         (id, kind, type, evidence, intensity, target, delta_json, confidence,
          source_message_id, created_at)
         VALUES (?, 'emotion', ?, ?, ?, ?, '{}', 1, ?, ?)`,
      )
        .bind(id, e.type, e.evidence.slice(0, 200), e.intensity, e.target, sourceMessageId ?? null, e.at)
        .run();
      n += res.meta.changes ?? 0;
    }
    return n;
  } catch {
    return 0;
  }
}

export async function recordFacetDelta(
  env: Env,
  delta: FacetDelta,
  evidence = '',
  now = Date.now(),
): Promise<boolean> {
  const changed = Object.values(delta).some((v) => Number(v) !== 0 && Number.isFinite(v));
  if (!changed) return false;
  try {
    const id = `affect_rel_${stableHash(`${JSON.stringify(delta)}|${now}`)}`;
    await env.DB.prepare(
      `INSERT OR IGNORE INTO affect_events
       (id, kind, type, evidence, intensity, target, delta_json, confidence, created_at)
       VALUES (?, 'relationship', 'facet_delta', ?, NULL, 'ai', ?, 1, ?)`,
    )
      .bind(id, evidence.slice(0, 200), JSON.stringify(delta), now)
      .run();
    return true;
  } catch {
    return false;
  }
}

/**
 * 把账本里这几条事件标成已翻篇（2026-11-11 判定纠正用）。
 *
 * 不删除，只写 resolved_at——和「记忆不删除、只是更难召回」同一个规矩。
 */
export async function markEventsResolved(env: Env, events: EmotionEvent[], now = Date.now()): Promise<number> {
  if (events.length === 0) return 0;
  try {
    let n = 0;
    for (const e of events) {
      const id = `affect_${stableHash(`${e.type}|${e.at}|${e.evidence}|${e.intensity}`)}`;
      const res = await env.DB.prepare(
        'UPDATE affect_events SET resolved_at = ? WHERE id = ? AND resolved_at IS NULL',
      )
        .bind(now, id)
        .run();
      n += res.meta.changes ?? 0;
    }
    return n;
  } catch {
    return 0;
  }
}

/**
 * 对账用：账本里「上次结算之后」累积的关系增量。
 *
 * 运行时状态存在 KV，账本存在 D1：KV 写失败时两边就会不一致（她会"记着"
 * 但数值没动）。结算前用账本重算一遍，以账本为准。
 */
export async function sumPendingFacetDelta(
  env: Env,
  sinceMs: number,
): Promise<FacetDelta | null> {
  try {
    const rows = await env.DB.prepare(
      `SELECT delta_json FROM affect_events
       WHERE kind = 'relationship' AND type = 'facet_delta' AND created_at > ?
       ORDER BY created_at ASC LIMIT 500`,
    )
      .bind(sinceMs)
      .all<{ delta_json: string }>();
    const list = rows.results ?? [];
    if (list.length === 0) return null;
    const sum: FacetDelta = {};
    for (const row of list) {
      let delta: FacetDelta = {};
      try {
        delta = JSON.parse(row.delta_json) as FacetDelta;
      } catch {
        continue;
      }
      for (const key of Object.keys(delta) as FacetKey[]) {
        const v = Number(delta[key]);
        if (Number.isFinite(v) && v !== 0) sum[key] = (sum[key] ?? 0) + v;
      }
    }
    return sum;
  } catch {
    return null;
  }
}

export async function recordAttitudeSnapshot(
  env: Env,
  policy: AttitudePolicy,
  facets: RelationFacets,
  vector: EmotionVector,
  now = Date.now(),
): Promise<string | null> {
  try {
    const id = `att_${stableHash(`${policy.policy_version}|${now}|${policy.text}`)}`;
    await env.DB.prepare(
      `INSERT OR IGNORE INTO attitude_snapshots
       (id, archetype, attitude, directives_json, facets_json, emotion_json, policy_version, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        policy.archetype,
        policy.attitude,
        JSON.stringify(policy.directives),
        JSON.stringify(facets),
        JSON.stringify(vector),
        policy.policy_version,
        now,
      )
      .run();
    return id;
  } catch {
    return null;
  }
}

export interface AffectTimelineItem {
  id: string;
  kind: 'emotion' | 'relationship';
  type: string;
  evidence: string;
  intensity: number | null;
  target: string | null;
  delta: unknown;
  created_at: number;
}

export async function listAffectTimeline(env: Env, limit = 50): Promise<AffectTimelineItem[]> {
  try {
    const rows = await env.DB.prepare(
      `SELECT id, kind, type, evidence, intensity, target, delta_json, created_at
       FROM affect_events ORDER BY created_at DESC LIMIT ?`,
    )
      .bind(Math.min(200, Math.max(1, limit)))
      .all<{
        id: string;
        kind: 'emotion' | 'relationship';
        type: string;
        evidence: string;
        intensity: number | null;
        target: string | null;
        delta_json: string;
        created_at: number;
      }>();
    return (rows.results ?? []).map((r) => {
      let delta: unknown = {};
      try {
        delta = JSON.parse(r.delta_json);
      } catch {
        /* ignore */
      }
      return {
        id: r.id,
        kind: r.kind,
        type: r.type,
        evidence: r.evidence,
        intensity: r.intensity,
        target: r.target,
        delta,
        created_at: r.created_at,
      };
    });
  } catch {
    return [];
  }
}
