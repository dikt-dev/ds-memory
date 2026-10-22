/**
 * 城市设置（阶段 4 T4.6）：网页端可修改天气城市。
 * 配置存 KV config:city（用 Open-Meteo 地理编码解析坐标）；未设置时回退 wrangler.toml 的 vars。
 */
import type { Env } from './types';

export interface CityConfig {
  city: string;
  latitude: number;
  longitude: number;
  updated_at: string;
}

export const CITY_CONFIG_KV = 'config:city';

export async function getCityConfig(env: Env): Promise<CityConfig> {
  try {
    const raw = await env.KV.get(CITY_CONFIG_KV);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<CityConfig>;
      if (
        typeof parsed.city === 'string' &&
        typeof parsed.latitude === 'number' &&
        typeof parsed.longitude === 'number'
      ) {
        return {
          city: parsed.city,
          latitude: parsed.latitude,
          longitude: parsed.longitude,
          updated_at: parsed.updated_at ?? '',
        };
      }
    }
  } catch {
    // 配置损坏则回退默认
  }
  return {
    city: env.CITY,
    latitude: Number(env.LATITUDE) || 0,
    longitude: Number(env.LONGITUDE) || 0,
    updated_at: '',
  };
}

/** 解析 Open-Meteo 地理编码结果（纯函数，可单测）。 */
export function parseGeocodeResult(
  data: unknown,
): { name: string; latitude: number; longitude: number } | null {
  const results = (data as { results?: unknown } | null)?.results;
  if (!Array.isArray(results) || results.length === 0) return null;
  const r = results[0] as { name?: unknown; latitude?: unknown; longitude?: unknown };
  if (typeof r?.name !== 'string' || typeof r?.latitude !== 'number' || typeof r?.longitude !== 'number') {
    return null;
  }
  return { name: r.name, latitude: r.latitude, longitude: r.longitude };
}

async function geocode(city: string): Promise<{ name: string; latitude: number; longitude: number }> {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=zh`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`地理编码失败（${res.status}）`);
  const parsed = parseGeocodeResult(await res.json());
  if (!parsed) throw new Error('找不到该城市，换个写法试试');
  return parsed;
}

/** 校验坐标范围（纯函数，可单测）。 */
export function isValidCoords(latitude: number, longitude: number): boolean {
  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
  );
}

/** 设置城市：有合法坐标则直接用（浏览器定位），否则按城市名地理编码 → 存 KV → 清理天气缓存。 */
export async function setCity(
  env: Env,
  city: string,
  coords?: { latitude: number; longitude: number },
): Promise<CityConfig> {
  let name = city;
  let latitude: number;
  let longitude: number;
  if (coords && isValidCoords(coords.latitude, coords.longitude)) {
    latitude = coords.latitude;
    longitude = coords.longitude;
  } else {
    const geo = await geocode(city);
    name = geo.name;
    latitude = geo.latitude;
    longitude = geo.longitude;
  }
  const prev = await getCityConfig(env);
  const config: CityConfig = {
    city: name,
    latitude,
    longitude,
    updated_at: new Date().toISOString(),
  };
  await env.KV.put(CITY_CONFIG_KV, JSON.stringify(config));
  await env.KV.delete(`weather:${prev.city}`).catch(() => {});
  await env.KV.delete(`weather:${config.city}`).catch(() => {});
  return config;
}
