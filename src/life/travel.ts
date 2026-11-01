/**
 * 旅行（P3-3 / §11.2）。
 *
 * 旅行是「她有生活」最有力的证据，所以频率要克制：约每月一次、2–3 天、
 * 回来那天是回家日（返程 + 收拾 + 累瘫）。
 *
 * 行程存在 KV 的 life:trip 里（不是 D1），因为它是「当前状态」而不是历史；
 * 落到 ai_day 的是每天的地点、at_home 和 recipe，历史照样能查。
 */
import type { Env } from '../types';
import { makeRng } from './seed';
import { CITIES } from './weather';

export interface Trip {
  city: string;
  /** 'YYYY-MM-DD' */
  start: string;
  /** 几天（含出发当天） */
  days: number;
}

const TRIP_KEY = 'life:trip';
/** 可选目的地：设计里定死的 12 城，去掉默认城（回老家另说） */
export const TRIP_CITIES = Object.keys(CITIES);

export function dayIndexOnTrip(trip: Trip, dateKey: string): number | null {
  const start = Date.parse(trip.start + 'T00:00:00+08:00');
  const day = Date.parse(dateKey + 'T00:00:00+08:00');
  const diff = Math.round((day - start) / 86400000);
  if (diff < 0 || diff >= trip.days) return null;
  return diff;
}

export async function readTrip(env: Env): Promise<Trip | null> {
  const raw = await env.KV.get(TRIP_KEY).catch(() => null);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<Trip>;
    if (!parsed.city || !parsed.start || typeof parsed.days !== 'number') return null;
    return { city: parsed.city, start: parsed.start, days: parsed.days };
  } catch {
    return null;
  }
}

export async function writeTrip(env: Env, trip: Trip | null): Promise<void> {
  if (!trip) {
    await env.KV.delete(TRIP_KEY).catch(() => {});
    return;
  }
  await env.KV.put(TRIP_KEY, JSON.stringify(trip)).catch(() => {});
}

/**
 * 今天要不要出发。
 *
 * 约每月一次：1.2%/天，20 天冷却，且必须在家（生病/旅行中不抽）。
 * 手上有活（健康度低）也不抽——这个在调用方判断。
 */
export function maybeStartTrip(input: {
  dateKey: string;
  daysSinceLastTrip: number | null;
  atHome: boolean;
  health: number;
}): Trip | null {
  if (!input.atHome || input.health < 90) return null;
  if (input.daysSinceLastTrip !== null && input.daysSinceLastTrip < 20) return null;
  const rng = makeRng(`trip|${input.dateKey}`);
  if (!rng.chance(0.012)) return null;
  const city = rng.pick(TRIP_CITIES);
  return { city, start: input.dateKey, days: rng.int(2, 3) };
}

/** 旅行期间的日程口径：预算、起床、允许的大类都更「出门」。 */
export const TRIP_DAY = {
  labels: ['出发', '第 2 天', '第 3 天'],
  budget: 3,
  wakeAt: 8 * 60,
};
