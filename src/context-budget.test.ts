import { describe, expect, it } from 'vitest';
import { budgetContext, formatBudgetManifest } from './context-budget';

describe('budgetContext', () => {
  it('核心记忆不被裁剪', () => {
    const core = '核心'.repeat(20);
    const result = budgetContext({
      core,
      recent: '近期'.repeat(100),
      rollup: '摘要'.repeat(100),
      recall: '召回'.repeat(100),
      maxChars: 40,
    });
    expect(result.core).toBe(core);
    expect(result.recent).toBe('');
    expect(result.rollup).toBe('');
    expect(result.recall).toBe('');
  });

  it('超预算时优先级是 core > recent > rollup > recall', () => {
    const result = budgetContext({
      core: 'C'.repeat(20),
      recent: 'R'.repeat(30),
      rollup: 'S'.repeat(200),
      recall: 'Q'.repeat(200),
      maxChars: 70,
    });
    expect(result.core).toHaveLength(20);
    expect(result.recent.length).toBeGreaterThan(0);
    expect(result.rollup.length).toBeGreaterThan(0);
    expect(result.recall.length).toBe(0);
    expect(result.totalChars).toBeLessThanOrEqual(100);
  });

  it('清单记录原长度、保留长度和裁剪状态', () => {
    const result = budgetContext({
      core: '核心',
      recent: '近'.repeat(30),
      rollup: '',
      recall: '召'.repeat(30),
      maxChars: 20,
    });
    expect(result.manifest).toHaveLength(4);
    const recent = result.manifest.find((m) => m.name === 'recent');
    expect(recent?.originalChars).toBe(30);
    expect(recent?.droppedChars).toBeGreaterThan(0);
    expect(formatBudgetManifest(result.manifest)).toContain('recent:');
  });
});
