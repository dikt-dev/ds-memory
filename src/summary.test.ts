import { describe, expect, it } from 'vitest';
import {
  buildSummaryInput,
  shouldSummarize,
  summaryKey,
  type DaySummary,
} from './summary';

describe('shouldSummarize', () => {
  it('无历史摘要：达到 12 条才首次触发', () => {
    expect(shouldSummarize(11, null, Date.now())).toBe(false);
    expect(shouldSummarize(12, null, Date.now())).toBe(true);
  });

  it('有历史摘要：新增不足 6 条且未到 20 分钟时不重复触发', () => {
    const now = Date.parse('2026-10-21T10:00:00Z');
    const fresh: DaySummary = { text: 'x', updated_at: '2026-10-21T09:50:00Z', up_to_id: 25, total: 25 };
    expect(shouldSummarize(28, fresh, now)).toBe(false); // 新增 3 条
    expect(shouldSummarize(30, fresh, now)).toBe(false); // 新增 5 条
    expect(shouldSummarize(31, fresh, now)).toBe(true); // 新增 6 条
  });

  it('有历史摘要：距上次超过 20 分钟也触发（即使新增很少）', () => {
    const now = Date.parse('2026-10-21T10:00:00Z');
    const boundary: DaySummary = { text: 'x', updated_at: '2026-10-21T09:30:00Z', up_to_id: 20, total: 20 };
    expect(shouldSummarize(21, boundary, now)).toBe(true);
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
