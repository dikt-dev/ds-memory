import { describe, expect, it } from 'vitest';
import { shouldSummarize, summaryKey, type DaySummary } from './summary';

describe('shouldSummarize', () => {
  it('无历史摘要：达到 20 条才触发', () => {
    expect(shouldSummarize(19, null, Date.now())).toBe(false);
    expect(shouldSummarize(20, null, Date.now())).toBe(true);
    expect(shouldSummarize(21, null, Date.now())).toBe(true);
  });

  it('有历史摘要：条数达标或距上次超过 2 小时', () => {
    const now = Date.parse('2026-10-21T10:00:00Z');
    const fresh: DaySummary = { text: 'x', updated_at: '2026-10-21T09:30:00Z', up_to_id: 5 };
    const stale: DaySummary = { text: 'x', updated_at: '2026-10-21T07:00:00Z', up_to_id: 5 };
    const boundary: DaySummary = { text: 'x', updated_at: '2026-10-21T08:00:00Z', up_to_id: 5 };
    expect(shouldSummarize(19, fresh, now)).toBe(false);
    expect(shouldSummarize(19, stale, now)).toBe(true);
    expect(shouldSummarize(19, boundary, now)).toBe(true); // 恰好 2 小时
    expect(shouldSummarize(20, fresh, now)).toBe(true);
  });
});

describe('summaryKey', () => {
  it('键名格式 summary:YYYY-MM-DD', () => {
    expect(summaryKey('2026-10-21')).toBe('summary:2026-10-21');
  });
});
