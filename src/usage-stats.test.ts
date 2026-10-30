import { describe, expect, it } from 'vitest';
import { summarizeUsage, type UsageRow } from './usage-stats';

const row = (over: Partial<UsageRow> = {}): UsageRow => ({
  day_key: '2026-10-30',
  channel: 'mobile',
  model: 'deepseek-flash',
  calls: 10,
  prompt_hit: 60_000,
  prompt_miss: 40_000,
  completion: 3_000,
  cost_rmb: 0.5,
  ...over,
});

describe('summarizeUsage', () => {
  it('空数据不炸，命中率为 0', () => {
    const s = summarizeUsage([], 7);
    expect(s.calls).toBe(0);
    expect(s.hitRate).toBe(0);
    expect(s.monthlyProjection).toBe(0);
  });

  it('命中率按 token 算，不是按次数算', () => {
    const s = summarizeUsage([row()], 1);
    expect(s.hitRate).toBeCloseTo(0.6, 5);
    expect(s.promptTokens).toBe(100_000);
  });

  it('多次调用累加，单次成本 = 总价 / 次数', () => {
    const s = summarizeUsage([row(), row({ calls: 30, cost_rmb: 1.5 })], 2);
    expect(s.calls).toBe(40);
    expect(s.costRmb).toBeCloseTo(2, 5);
    expect(s.costPerCall).toBeCloseTo(0.05, 5);
  });

  it('月投影按传入天数线性外推', () => {
    expect(summarizeUsage([row({ cost_rmb: 1 })], 10).monthlyProjection).toBeCloseTo(3, 5);
  });

  it('只有未命中时命中率为 0，不会除零', () => {
    const s = summarizeUsage([row({ prompt_hit: 0, prompt_miss: 1000 })], 1);
    expect(s.hitRate).toBe(0);
  });
});