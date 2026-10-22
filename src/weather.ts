/**
 * 天气服务：Open-Meteo（免费、无需 Key）+ KV 缓存 30 分钟。
 * 失败降级：读过期缓存 → 都没有则返回 null（调用方用占位/省略天气）。
 */
import type { Env } from './types';
import type { WeatherInfo } from './prompt';
import { getCityConfig } from './settings';

const KV_PREFIX = 'weather:';
export const WEATHER_CACHE_TTL_SECONDS = 30 * 60;

/** WMO 天气代码 → 中文描述（Open-Meteo 使用的 WMO 4677 代码表）。 */
const WMO_CODES: Record<number, string> = {
  0: '晴',
  1: '大致晴朗',
  2: '多云',
  3: '阴',
  45: '雾',
  48: '雾凇',
  51: '小毛毛雨',
  53: '毛毛雨',
  55: '大毛毛雨',
  56: '冻毛毛雨',
  57: '强冻毛毛雨',
  61: '小雨',
  63: '中雨',
  65: '大雨',
  66: '冻雨',
  67: '强冻雨',
  71: '小雪',
  73: '中雪',
  75: '大雪',
  77: '霰',
  80: '阵雨',
  81: '强阵雨',
  82: '强雷阵雨',
  85: '阵雪',
  86: '强阵雪',
  95: '雷雨',
  96: '雷雨伴冰雹',
  99: '强雷雨伴冰雹',
};

export function describeWeatherCode(code: number): string {
  return WMO_CODES[code] ?? `天气代码 ${code}`;
}

interface CachedWeather extends WeatherInfo {
  updated_at: string;
}

function isFresh(updatedAt: string): boolean {
  const ageMs = Date.now() - new Date(updatedAt).getTime();
  return Number.isFinite(ageMs) && ageMs < WEATHER_CACHE_TTL_SECONDS * 1000;
}

function parseCache(raw: string | null): CachedWeather | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as CachedWeather;
    if (typeof parsed.temp_c === 'number' && typeof parsed.desc === 'string') return parsed;
    return null;
  } catch {
    return null;
  }
}

export async function fetchWeather(env: Env): Promise<WeatherInfo | null> {
  const cfg = await getCityConfig(env);
  const key = `${KV_PREFIX}${cfg.city}`;
  const cached = parseCache(await env.KV.get(key).catch(() => null));
  if (cached && isFresh(cached.updated_at)) {
    return { city: cached.city, temp_c: cached.temp_c, desc: cached.desc };
  }

  try {
    const url =
      `https://api.open-meteo.com/v1/forecast` +
      `?latitude=${encodeURIComponent(String(cfg.latitude))}&longitude=${encodeURIComponent(String(cfg.longitude))}` +
      `&current=temperature_2m,weather_code&timezone=Asia%2FShanghai`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`open-meteo status ${res.status}`);
    const data = (await res.json()) as {
      current?: { temperature_2m?: number; weather_code?: number };
    };
    const temp = data.current?.temperature_2m;
    const code = data.current?.weather_code;
    if (typeof temp !== 'number' || typeof code !== 'number') {
      throw new Error('open-meteo missing current data');
    }
    const info: CachedWeather = {
      city: cfg.city,
      temp_c: Math.round(temp * 10) / 10,
      desc: describeWeatherCode(code),
      updated_at: new Date().toISOString(),
    };
    await env.KV.put(key, JSON.stringify(info), { expirationTtl: WEATHER_CACHE_TTL_SECONDS });
    return { city: info.city, temp_c: info.temp_c, desc: info.desc };
  } catch (e) {
    console.error('[weather] fetch failed:', e);
    // 降级：返回过期缓存（若有）
    if (cached) return { city: cached.city, temp_c: cached.temp_c, desc: cached.desc };
    return null;
  }
}
