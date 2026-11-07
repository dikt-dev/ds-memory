/**
 * 上下文快照：把每轮都要读的那几块合成**一个 KV key**。
 *
 * 为什么需要（2026-11-08 实测）：
 * - 拼提示词的 JS 计算不到 1ms，CPU 根本不是瓶颈；
 * - 真正的成本是**跨区往返**：D1 在 us-west，每次查询 60~80ms；
 * - 一轮原来要读 memory(R2+KV)、day context(R2)、weather(HTTP)、
 *   memo(D1)、summary(D1)、persona state(D1)、topics(D1×3) —— 7+ 次往返。
 *
 * 现在：1 次 KV 读（同 colo，1~5ms）拿到全部；过期才回退到分散读取，
 * 并在后台重建（不阻塞这一轮回复）。
 *
 * 注意：和 memory-snapshot.ts（AI 的每日自我快照）不是一回事，别混。
 */
import type { Env } from './types';
import { dateKeyInBeijing } from './date';
import { getMemory } from './memory';
import { getOrCreateDayContext } from './context';
import type { DayContextFile } from './context';
import { fetchWeather } from './weather';
import type { WeatherInfo } from './prompt';
import { getRecentMemo, formatRecentMemoBlock } from './recent-memory';
import { getTodaySummary } from './summary';
import { recentTopicsBlock } from './topics';
import { loadPersonaState } from './persona-drift';
import type { PersonaState } from './persona-drift';
import { resolveHerPlace } from './life/where';
import { logError } from './error-log';

export const CONTEXT_SNAPSHOT_KEY = 'ctx:snapshot:v1';
export const CONTEXT_SNAPSHOT_TTL_MS = 10 * 60 * 1000;

export interface ContextSnapshot {
  at: number;
  dateKey: string;
  memory: string;
  dayCtx: DayContextFile;
  weather: WeatherInfo | null;
  memo: string | null;
  summary: string | null;
  topics: string;
  personaState: PersonaState;
}

export function contextSnapshotFresh(snap: ContextSnapshot | null, now: Date): boolean {
  return Boolean(snap && typeof snap.at === 'number' && now.getTime() - snap.at < CONTEXT_SNAPSHOT_TTL_MS);
}

export async function readContextSnapshot(env: Env): Promise<ContextSnapshot | null> {
  return await env.KV.get<ContextSnapshot>(CONTEXT_SNAPSHOT_KEY, 'json').catch(() => null);
}

/** 逐个读齐所有块（快照过期时的回退路径，也是重建的实现）。 */
export async function loadAllBlocks(
  env: Env,
  now: Date,
  opts: { memoMaxItems?: number } = {},
): Promise<ContextSnapshot> {
  const dateKey = dateKeyInBeijing(now);
  const herPlace = await resolveHerPlace(env, dateKey).catch(() => null);
  const [memory, dayCtx, weather, memoRaw, summary, personaState, topics] = await Promise.all([
    getMemory(env),
    getOrCreateDayContext(env, dateKey),
    fetchWeather(env, herPlace?.city).catch(() => null),
    getRecentMemo(env).catch(() => null),
    getTodaySummary(env, dateKey).catch(() => null),
    loadPersonaState(env).catch(() => null),
    recentTopicsBlock(env, now).catch(() => ''),
  ]);
  return {
    at: now.getTime(),
    dateKey,
    memory,
    dayCtx,
    weather: weather ?? dayCtx?.weather ?? null,
    memo: formatRecentMemoBlock(memoRaw, opts.memoMaxItems) || null,
    summary,
    topics,
    personaState: (personaState ?? {}) as PersonaState,
  };
}

export async function rebuildContextSnapshot(env: Env, now: Date): Promise<boolean> {
  try {
    const snap = await loadAllBlocks(env, now);
    await env.KV.put(CONTEXT_SNAPSHOT_KEY, JSON.stringify(snap), { expirationTtl: 3600 });
    return true;
  } catch (e) {
    logError('[ctx-snapshot] rebuild failed:', e);
    return false;
  }
}

/** 过期才重建（cron 调用；5 分钟一次 tick，实际 10 分钟建一次）。 */
export async function ensureContextSnapshot(env: Env, now: Date = new Date()): Promise<boolean> {
  const snap = await readContextSnapshot(env);
  if (contextSnapshotFresh(snap, now)) return false;
  return await rebuildContextSnapshot(env, now);
}
