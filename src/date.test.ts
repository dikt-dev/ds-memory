import { describe, expect, it } from 'vitest';
import { spokenTime } from './date';

describe('spokenTime（按半小时取整）', () => {
  it('21:11 → 晚上九点（<15 分算整点）', () => {
    expect(spokenTime(new Date('2026-10-29T13:11:00Z'))).toBe('晚上九点');
  });

  it('21:05 → 晚上九点', () => {
    expect(spokenTime(new Date('2026-10-29T13:05:00Z'))).toBe('晚上九点');
  });

  it('21:00 → 晚上九点', () => {
    expect(spokenTime(new Date('2026-10-29T13:00:00Z'))).toBe('晚上九点');
  });

  it('21:20 → 晚上九点半（15–44 分算半点）', () => {
    expect(spokenTime(new Date('2026-10-29T13:20:00Z'))).toBe('晚上九点半');
  });

  it('21:44 → 晚上九点半', () => {
    expect(spokenTime(new Date('2026-10-29T13:44:00Z'))).toBe('晚上九点半');
  });

  it('21:45 → 晚上十点（>=45 分进位）', () => {
    expect(spokenTime(new Date('2026-10-29T13:45:00Z'))).toBe('晚上十点');
  });

  it('23:50 → 凌晨零点（跨零点进位）', () => {
    expect(spokenTime(new Date('2026-10-29T15:50:00Z'))).toBe('凌晨零点');
  });

  it('12:30 → 中午十二点半', () => {
    expect(spokenTime(new Date('2026-10-29T04:30:00Z'))).toBe('中午十二点半');
  });

  it('00:10 → 凌晨零点', () => {
    expect(spokenTime(new Date('2026-10-28T16:10:00Z'))).toBe('凌晨零点');
  });
});
