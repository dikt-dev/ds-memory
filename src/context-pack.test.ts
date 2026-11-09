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
    expect(budget.recentMemo).toContain('面');
    expect(budget.recent).toBe('');
  });
});

describe('快照分支（ctx:snapshot:v2）', () => {
  const NL = String.fromCharCode(10);
  const snapJson = (over: Record<string, unknown> = {}) => ({
    at: Date.now(),
    dateKey: '2026-11-08',
    memory: ['## 人物底色', '- [26-11-08] 她嘴硬心软'].join(NL),
    dayCtx: { date: '2026-11-08', weekday: '周六', is_holiday: false, holiday_note: '' },
    weather: null,
    memoRaw: {
      items: [
        { at: '2026-11-08T04:00:00.000Z', text: '中午吃了面', superseded: false },
        { at: '2026-11-08T05:00:00.000Z', text: '晚上在改记忆系统', superseded: false },
      ],
      up_to_id: 1,
      updated_at: '2026-11-08T05:00:00.000Z',
    },
    summary: '今天的摘要',
    topics: '记忆系统',
    personaState: { values: {}, baseline: {}, updatedAt: '', lastReview: '', history: [] },
    ...over,
  });

  const envWith = (snap: unknown) =>
    ({
      KV: { get: async () => snap, put: async () => undefined, delete: async () => undefined },
      MEMORY_PROMPT_MODE: 'tiered',
      MEMORY_EVENT_INLINE_DAYS: '60',
    }) as never;

  it('快照命中时中期记忆不丢（web 丢过），今日摘要按规则让位', async () => {
    const { buildMemoryPack } = await import('./context-pack');
    const pack = await buildMemoryPack(envWith(snapJson()), new Date(), { channel: 'web' });
    expect(pack.recentMemoRaw).not.toBeNull();
    expect(pack.recentMemo).toContain('中午吃了面');
    expect(pack.todaySummary).toBeNull();
  });

  it('会话起点过滤照旧生效（会话内的条目不重复注入）', async () => {
    const { buildMemoryPack } = await import('./context-pack');
    const pack = await buildMemoryPack(envWith(snapJson()), new Date(), {
      channel: 'web',
      sessionStartMs: Date.parse('2026-11-08T04:30:00.000Z'),
    });
    // 会话起点之前的事要带上；会话开始之后的条目历史里已经有原文，不再重复注入
    expect(pack.recentMemo).toContain('中午吃了面');
    expect(pack.recentMemo).not.toContain('晚上在改记忆系统');
  });

  it('v1 旧快照仍能读出来（memo 是字符串，退化成整块带上）', async () => {
    const { readContextSnapshot } = await import('./context-snapshot');
    const calls: string[] = [];
    const env = {
      KV: {
        get: async (key: string) => {
          calls.push(key);
          if (key === 'ctx:snapshot:v2') return null;
          return {
            at: Date.now(),
            dateKey: '2026-11-08',
            memory: '## 人物底色',
            dayCtx: { date: '2026-11-08', weekday: '周六', is_holiday: false, holiday_note: '' },
            weather: null,
            memo: ['## 最近三天（中期记忆）', '- 旧格式的中期记忆'].join(NL),
            summary: null,
            topics: '',
            personaState: {},
          };
        },
      },
    } as never;
    const snap = await readContextSnapshot(env);
    expect(calls).toContain('ctx:snapshot:v2');
    expect(snap?.memoRaw?.items?.length).toBe(1);
    expect(snap?.memoRaw?.items?.[0]?.text).toContain('旧格式的中期记忆');
  });
});
