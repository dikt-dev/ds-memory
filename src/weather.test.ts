import { describe, expect, it } from 'vitest';
import { describeWeatherCode, WEATHER_CACHE_TTL_SECONDS } from './weather';

describe('WMO 天气代码', () => {
  it('常见代码映射', () => {
    expect(describeWeatherCode(0)).toBe('晴');
    expect(describeWeatherCode(2)).toBe('多云');
    expect(describeWeatherCode(3)).toBe('阴');
    expect(describeWeatherCode(45)).toBe('雾');
    expect(describeWeatherCode(61)).toBe('小雨');
    expect(describeWeatherCode(65)).toBe('大雨');
    expect(describeWeatherCode(71)).toBe('小雪');
    expect(describeWeatherCode(80)).toBe('阵雨');
    expect(describeWeatherCode(95)).toBe('雷雨');
    expect(describeWeatherCode(99)).toBe('强雷雨伴冰雹');
  });

  it('未知代码兜底', () => {
    expect(describeWeatherCode(123)).toBe('天气代码 123');
  });

  it('缓存 TTL 为 30 分钟', () => {
    expect(WEATHER_CACHE_TTL_SECONDS).toBe(1800);
  });
});
