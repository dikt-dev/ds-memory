import { describe, expect, it } from 'vitest';
import {
  buildSummaryInput,
  shouldSummarize,
  summaryKey,
  type DaySummary,
} from './summary';

describe('shouldSummarize', () => {
  it('无历史摘要：达到 20 条才首次触发', () => {
    expect(shouldSummarize(19, null, Date.now())).toBe(false);
    expect(shouldSummarize(20, null, Date.now())).toBe(true);
    expect(shouldSummarize(21, null, Date.now())).toBe(true);
  });

  it('有历史摘要：新增不足 10 条且未到 1 小时时不重复触发', () => {
    const now = Date.parse('2026-10-21T10:00:00Z');
    const fresh: DaySummary = {
      text: 'x',
      updated_at: '2026-10-21T09:30:00Z',
      up_to_id: 25,
      total: 25,
    };
    expect(shouldSummarize(29, fresh, now)).toBe(false); // 新增 4 条
    expect(shouldSummarize(34, fresh, now)).toBe(false); // 新增 9 条
    expect(shouldSummarize(35, fresh, now)).toBe(true); // 新增 10 条
  });

  it('有历史摘要：新增达到 10 条就触发', () => {
    const now = Date.parse('2026-10-21T10:00:00Z');
    const prev: DaySummary = {
      text: 'x',
      updated_at: '2026-10-21T09:30:00Z',
      up_to_id: 20,
      total: 20,
    };
    expect(shouldSummarize(29, prev, now)).toBe(false);
    expect(shouldSummarize(30, prev, now)).toBe(true);
  });

  it('有历史摘要：距上次超过 1 小时也触发（即使新增很少）', () => {
    const now = Date.parse('2026-10-21T10:00:00Z');
    const boundary: DaySummary = {
      text: 'x',
      updated_at: '2026-10-21T09:00:00Z',
      up_to_id: 20,
      total: 20,
    };
    const stale: DaySummary = {
      text: 'x',
      updated_at: '2026-10-21T08:00:00Z',
      up_to_id: 20,
      total: 20,
    };
    expect(shouldSummarize(22, boundary, now)).toBe(true);
    expect(shouldSummarize(22, stale, now)).toBe(true);
  });
});

describe('buildSummaryInput', () => {
  it('保留旧摘要，并取最新的一段对话（不丢最新）', () => {
    const old = '旧摘要内容';
    const conversation = `最早的内容${'中'.repeat(20000)}最新的内容`;
    const input = buildSummaryInput(old, conversation);
    expect(input.startsWith('此前今日摘要：旧摘要内容')).toBe(true);
    expect(input).toContain('最新的内容');
    expect(input).not.toContain('最早的内容');
  });

  it('短对话原样拼接', () => {
    expect(buildSummaryInput(null, '用户：在吗')).toBe('用户：在吗');
    expect(buildSummaryInput('旧', '新')).toContain('旧');
    expect(buildSummaryInput('旧', '新')).toContain('新');
  });
});

describe('summaryKey', () => {
  it('键名格式 summary:YYYY-MM-DD', () => {
    expect(summaryKey('2026-10-21')).toBe('summary:2026-10-21');
  });
});
