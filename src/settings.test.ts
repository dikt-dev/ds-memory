import { describe, expect, it } from 'vitest';
import { isValidCoords, parseGeocodeResult } from './settings';

describe('parseGeocodeResult', () => {
  it('解析正常结果', () => {
    expect(
      parseGeocodeResult({ results: [{ name: '北京', latitude: 22.5431, longitude: 114.0579 }] }),
    ).toEqual({ name: '北京', latitude: 22.5431, longitude: 114.0579 });
  });

  it('空结果返回 null', () => {
    expect(parseGeocodeResult({ results: [] })).toBeNull();
    expect(parseGeocodeResult(null)).toBeNull();
    expect(parseGeocodeResult({})).toBeNull();
  });

  it('字段类型畸形返回 null', () => {
    expect(parseGeocodeResult({ results: [{ name: 'x', latitude: 'bad', longitude: 1 }] })).toBeNull();
    expect(parseGeocodeResult({ results: [{ name: 42, latitude: 1, longitude: 1 }] })).toBeNull();
  });
});

describe('isValidCoords', () => {
  it('合法坐标', () => {
    expect(isValidCoords(22.5431, 114.0579)).toBe(true);
    expect(isValidCoords(-33.86, 151.21)).toBe(true);
    expect(isValidCoords(0, 0)).toBe(true);
  });

  it('越界或非数值坐标', () => {
    expect(isValidCoords(91, 0)).toBe(false);
    expect(isValidCoords(0, 181)).toBe(false);
    expect(isValidCoords(NaN, 0)).toBe(false);
    expect(isValidCoords(Infinity, 0)).toBe(false);
  });
});
