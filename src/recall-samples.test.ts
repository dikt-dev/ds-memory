import { describe, expect, it } from 'vitest';
import { percentile, summarizeSamples, type RecallSampleRow } from './recall-samples';

const row = (over: Partial<RecallSampleRow> = {}): RecallSampleRow => ({
  day_key: '2026-10-30',
  channel: 'mobile',
  mode: 'shadow',
  kind: 'memory',
  legacyMs: 10,
  loadMs: 40,
  rankMs: 5,
  embedMs: 0,
  expandMs: 30,
  totalMs: 90,
  items: 6,
  linked: 1,
  hasVector: false,
  timedOut: false,
  legacySkipped: false,
  created_at: 0,
  ...over,
});

describe('percentile', () => {
  it('空数组返回 0', () => expect(percentile([], 95)).toBe(0));
  it('单值返回自身', () => expect(percentile([7], 95)).toBe(7));
  it('p95 取到长尾而不是平均值', () => {
    expect(percentile([1, 2, 3, 4, 100], 95)).toBe(100);
    expect(percentile([1, 2, 3, 4, 100], 50)).toBe(3);
  });
});

describe('summarizeSamples', () => {
  it('空样本返回 null', () => expect(summarizeSamples([])).toBeNull());

  it('统计各段 p50/p95 与超时率', () => {
    const rows = [
      row(),
      row({ totalMs: 200, embedMs: 120, loadMs: 60 }),
      row({ timedOut: true, items: 0, totalMs: 1500 }),
    ];
    const s = summarizeSamples(rows)!;
    expect(s.n).toBe(3);
    expect(s.total.max).toBe(1500);
    expect(s.total.p50).toBe(200);
    expect(s.stages.embed.p95).toBe(120);
    expect(s.timedOutRate).toBeCloseTo(1 / 3, 3);
    expect(s.avgItems).toBe(4);
  });

  it('占比之和约等于 1（用 p95 计算）', () => {
    const s = summarizeSamples([row(), row({ embedMs: 100 })])!;
    const sum = Object.values(s.share).reduce((a, b) => a + b, 0);
    expect(sum).toBeGreaterThan(0.95);
    expect(sum).toBeLessThan(1.05);
  });
});