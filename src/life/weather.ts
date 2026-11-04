/**
 * 天气与位置（P1-1 / P1-2）。
 *
 * 数据源用 Open-Meteo：免费、不要 key、按经纬度查。国内访问比国外那些稳。
 * 结果缓存在 KV 的 life:env:{dateKey} 里，装填日程时只读 KV，不在关键路径发请求。
 */
import type { Env } from '../types';
import { logError } from '../error-log';
import { dayIndexOnTrip, readTrip } from './travel';

import { CITIES } from './cities';
export { CITIES };

/** WMO 天气代码 → 我们池子里用的四类。 */
export function weatherFromCode(code: number): 'sunny' | 'cloudy' | 'rain' | 'snow' {
  if (code === 0) return 'sunny';
  if (code >= 1 && code <= 3) return 'cloudy';
  if (code === 45 || code === 48) return 'cloudy';
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82) || code >= 95) return 'rain';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
  return 'cloudy';
}

export interface WeatherNow {
  weather: 'sunny' | 'cloudy' | 'rain' | 'snow';
  tempC: number;
}

/**
 * 查某个城市现在的天气。
 *
 * 失败返回 null，调用方保留旧值/默认值——天气挂了不该让日程也挂。
 */
export async function fetchWeather(city: string): Promise<WeatherNow | null> {
const geo = CITIES[city] ?? CITIES['上海'];
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${geo.lat}&longitude=${geo.lon}` +
    '&current=temperature_2m,weather_code&timezone=Asia%2FShanghai';
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      current?: { temperature_2m?: number; weather_code?: number };
    };
    const temp = data.current?.temperature_2m;
    const code = data.current?.weather_code;
    if (typeof temp !== 'number' || typeof code !== 'number') return null;
    return { weather: weatherFromCode(code), tempC: Math.round(temp) };
  } catch (e) {
    logError('[life] 天气查询失败:', e);
    return null;
  }
}

export function nearestCity(lat: number, lng: number): string {
  let best = '上海';
  let bestD = Infinity;
  for (const [name, g] of Object.entries(CITIES)) {
    const d = (g.lat - lat) ** 2 + (g.lon - lng) ** 2;
    if (d < bestD) {
      bestD = d;
      best = name;
    }
  }
  return best;
}

export interface LifeEnvRecord {
  location: string;
  atHome: boolean;
  weather: string;
  tempC: number;
  updatedAt: string;
}

/** 刷新某天的环境（城市 + 天气），写进 KV 给装填用。 */
export async function refreshLifeEnv(
  env: Env,
  dateKey: string,
  opts: { city?: string } = {},
): Promise<LifeEnvRecord | null> {
  // 天气要跟着她的实际位置：旅游期间是目的地，否则是常住城市
  let tripCity: string | null = null;
  try {
    const trip = await readTrip(env);
    if (trip && dayIndexOnTrip(trip, dateKey) !== null) tripCity = trip.city;
  } catch {
    tripCity = null;
  }
  const city =
    opts.city ?? tripCity ?? (await env.KV.get('life:home-city').catch(() => null)) ?? env.CITY ?? '上海';
  const now = await fetchWeather(city);
  const record: LifeEnvRecord = {
    location: city,
    // 旅游日不在家：atHome 决定装填只挑户外单元
    atHome: tripCity === null,
    weather: now?.weather ?? 'cloudy',
    tempC: now?.tempC ?? 20,
    updatedAt: new Date().toISOString(),
  };
  await env.KV.put(`life:env:${dateKey}`, JSON.stringify(record), {
    expirationTtl: 60 * 60 * 36,
  }).catch(() => {});
  return now ? record : null;
}
