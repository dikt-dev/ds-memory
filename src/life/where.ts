/**
 * 她此刻在哪：常住城市 / 旅游目的地。
 *
 * 规则（2026-11-06 明确）：
 *   1. 她住在「常住城市」（KV life:home-city，缺省 env.CITY）；
 *   2. 旅游期间，她的**当前位置**就是目的地——日程里的 ai_day.location 已经是这个值；
 *   3. 他不知道她在哪不重要，重要的是她只知道**自己所在地**的天气。
 *
 * 优先级：今天已生成的日程（ai_day.location）> 行程表（life:trip）> 常住城市。
 * 为什么先看 ai_day：日程是当天 0 点生成的快照，旅游中途改行程时它也最接近事实。
 */
import type { Env } from '../types';
import { readTrip, dayIndexOnTrip } from './travel';

export interface HerPlace {
  /** 她此刻所在的城市 */
  city: string;
  /** 是否在外地（旅游） */
  traveling: boolean;
}

export async function resolveHerPlace(env: Env, dateKey: string): Promise<HerPlace> {
  const home = (await env.KV?.get('life:home-city').catch(() => null)) || env.CITY || '上海';

  // 1) 今天的日程：旅游日写的是目的地，平常日写的是常住城市
  try {
    const row = await env.DB.prepare('SELECT location FROM ai_day WHERE date_key = ?')
      .bind(dateKey)
      .first<{ location: string | null }>();
    const loc = row?.location?.trim();
    if (loc) return { city: loc, traveling: loc !== home };
  } catch {
    // 没有 ai_day 表/没生成日程：往下走
  }

  // 2) 行程表：今天在旅途里就是目的地
  try {
    const trip = await readTrip(env);
    if (trip && dayIndexOnTrip(trip, dateKey) !== null) {
      return { city: trip.city, traveling: true };
    }
  } catch {
    // 行程读不到就当在家
  }

  return { city: home, traveling: false };
}
