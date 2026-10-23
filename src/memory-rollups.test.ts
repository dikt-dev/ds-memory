import { describe, expect, it } from 'vitest';
import { previousPeriods, weekStartKey } from './memory-rollups';

describe('weekStartKey', () => {
  it('返回所在周的周一（跨月/跨年也正确）', () => {
    expect(weekStartKey('2026-10-23')).toBe('2026-10-19'); // 周五 → 周一
    expect(weekStartKey('2026-10-19')).toBe('2026-10-19'); // 周一
    expect(weekStartKey('2026-11-01')).toBe('2026-10-26'); // 周日 → 上周一
  });
});

describe('previousPeriods', () => {
  it('给出上一个完整周（周一）与上一个月', () => {
    const p = previousPeriods('2026-10-23');
    expect(p.week).toBe('2026-10-12');
    expect(p.month).toBe('2026-09');
    const jan = previousPeriods('2027-01-05');
    expect(jan.month).toBe('2026-12');
  });
});
