/**
 * 关系阶段的持久化与推进（迟滞）。
 *
 * 为什么需要存：阶段不能让数值在阈值附近来回跳。
 * 晋升：达到下一阶段并连续保持 3 天；回退：跌破当前阶段下限 60 分并连续 7 天。
 * 只升/降一级，避免一次波动跨两级。
 */
import type { Env } from './types';
import { getRuntimeState, putRuntimeState } from './runtime-store';
import { STAGE_LEVELS, closeness, stageFor, type RelationFacets } from './relation-facets';

const KEY = 'relation:stage';
const PROMOTE_DAYS = 3;
const DEMOTE_DAYS = 7;
const GUARD = 60;

interface Stored {
  level: number;
  since: string;
  promoteSince: string | null;
  dropSince: string | null;
}

async function load(env: Env): Promise<Stored | null> {
  const raw = await getRuntimeState(env, KEY).catch(() => null);
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as Partial<Stored>;
    if (typeof s.level !== 'number') return null;
    return {
      level: Math.max(0, Math.min(4, Math.round(s.level))),
      since: typeof s.since === 'string' ? s.since : new Date().toISOString(),
      promoteSince: typeof s.promoteSince === 'string' ? s.promoteSince : null,
      dropSince: typeof s.dropSince === 'string' ? s.dropSince : null,
    };
  } catch {
    return null;
  }
}

async function save(env: Env, st: Stored): Promise<void> {
  await putRuntimeState(env, KEY, JSON.stringify(st), 86400 * 400).catch(() => {});
}

/** 只读：当前生效的阶段等级（没存过返回 null，调用方用派生值）。 */
export async function readRelationStageLevel(env: Env): Promise<number | null> {
  const st = await load(env);
  return st ? st.level : null;
}

/** 每日结算：根据当天 5 轴推进/回退阶段，返回生效等级。 */
export async function settleRelationStage(
  env: Env,
  facets: RelationFacets,
  now = new Date(),
): Promise<number> {
  const derived = stageFor(facets).level;
  const st = await load(env);
  if (!st) {
    const fresh: Stored = { level: derived, since: now.toISOString(), promoteSince: null, dropSince: null };
    await save(env, fresh);
    return fresh.level;
  }
  const day = 86400_000;
  let { level, promoteSince, dropSince } = st;
  if (derived > level) {
    promoteSince ??= now.toISOString();
    if (now.getTime() - Date.parse(promoteSince) >= PROMOTE_DAYS * day) {
      level = Math.min(level + 1, derived);
      promoteSince = null;
    }
    dropSince = null;
  } else if (derived < level) {
    if (closeness(facets) < STAGE_LEVELS[level].min - GUARD) {
      dropSince ??= now.toISOString();
      if (now.getTime() - Date.parse(dropSince) >= DEMOTE_DAYS * day) {
        level = Math.max(level - 1, 0);
        dropSince = null;
      }
    } else {
      dropSince = null;
    }
    promoteSince = null;
  } else {
    promoteSince = null;
    dropSince = null;
  }
  await save(env, { level, since: st.since, promoteSince, dropSince });
  return level;
}
