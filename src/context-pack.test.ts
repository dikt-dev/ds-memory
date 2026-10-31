import { describe, expect, it } from 'vitest';
import { budgetFromPack, shouldSkipMemoryRecall, type MemoryPack } from './context-pack';

function pack(over: Partial<MemoryPack> = {}): MemoryPack {
  return {
    memory: '# 长期记忆',
    dayCtxFile: { date: '2026-10-31', weekday: '周六', is_holiday: false, holiday_note: '' } as never,
    weather: null,
    ctx: { date: '2026-10-31', weekday: '周六', is_holiday: false, holiday_note: '' },
    promptMemory: { text: '## 人物底色\n- 她嘴硬心软', mode: 'compact', evidence: true },
    recentMemoRaw: null,
    recentMemo: null,
    todaySummary: '今天在走回滚流程',
    personaState: { values: {}, baseline: {}, updatedAt: '', lastReview: '', history: [] } as never,
    personaDrift: null,
    ...over,
  };
}

describe('shouldSkipMemoryRecall', () => {
  it('全量注入时跳过 memory 来源', () => {
    expect(shouldSkipMemoryRecall(pack({ promptMemory: { text: 'x', mode: 'full' } }))).toBe(true);
  });

  it('evidence 模式必须放行，否则她什么都想不起来', () => {
    expect(
      shouldSkipMemoryRecall(pack({ promptMemory: { text: 'x', mode: 'compact', evidence: true } })),
    ).toBe(false);
  });

  it('compact（超长记忆）也放行', () => {
    expect(shouldSkipMemoryRecall(pack({ promptMemory: { text: 'x', mode: 'compact' } }))).toBe(false);
  });
});

describe('budgetFromPack', () => {
  it('召回文本按预算装填', () => {
    const { recalled, budget } = budgetFromPack(pack(), '- [26-10-30] 她记得奶茶', ['历史一条']);
    expect(recalled).toContain('奶茶');
    expect(budget.core).toContain('人物底色');
  });

  it('与历史重复的召回被去掉', () => {
    const duplicated = '- [26-10-30] 今天在走回滚流程';
    const { recalled } = budgetFromPack(pack(), duplicated, ['今天在走回滚流程']);
    expect(recalled.trim()).toBe('');
  });

  it('空召回不报错', () => {
    const { recalled, budget } = budgetFromPack(pack(), '', []);
    expect(recalled).toBe('');
    expect(budget.totalChars).toBeGreaterThan(0);
  });

  it('中期记忆存在时进 rollup，今日摘要为空', () => {
    const { budget } = budgetFromPack(pack({ recentMemo: '- 中午吃了面', todaySummary: null }), '', []);
    expect(budget.rollup).toContain('面');
    expect(budget.recent).toBe('');
  });
});
