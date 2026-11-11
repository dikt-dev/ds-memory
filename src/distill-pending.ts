/**
 * 「今天提炼失败」的待补清单（2026-11-11）。
 *
 * 主办方和 Workers AI 都挂了时不写记忆，只记下这一天的日期；
 * 下一次归档先补它——漏一天可以补，写错一天没法改。
 */
import type { Env } from './types';
import { getRuntimeState, putRuntimeState } from './runtime-store';

const PENDING_KEY = 'distill_pending';
/** 最多记 5 天，避免长期失败把清单撑爆。 */
const PENDING_CAP = 5;
const PENDING_TTL_SECONDS = 30 * 24 * 60 * 60;

/** 读待补日期（按时间升序）。 */
export async function listDistillPending(env: Env): Promise<string[]> {
  try {
    const raw = await getRuntimeState(env, PENDING_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw) as unknown;
    return Array.isArray(list) ? list.filter((d): d is string => typeof d === 'string') : [];
  } catch {
    return [];
  }
}

/** 记下这一天：等下次归档补。 */
export async function markDistillPending(env: Env, dateKey: string): Promise<void> {
  const list = await listDistillPending(env);
  if (list.includes(dateKey)) return;
  const next = [...list, dateKey].slice(-PENDING_CAP);
  await putRuntimeState(env, PENDING_KEY, JSON.stringify(next), PENDING_TTL_SECONDS).catch(() => {});
}

/** 补完（或确认没东西可补）就移除。 */
export async function clearDistillPending(env: Env, dateKey: string): Promise<void> {
  const list = await listDistillPending(env);
  if (!list.includes(dateKey)) return;
  const next = list.filter((d) => d !== dateKey);
  await putRuntimeState(env, PENDING_KEY, JSON.stringify(next), PENDING_TTL_SECONDS).catch(() => {});
}