import { describe, expect, it } from 'vitest';
import { qwenBalanceInfo, readQwenSpend } from './qwen-balance';
import type { Env } from './types';

/** chat_usage 汇总：没有表/没数据时一律 0，不能抛。 */
function fakeEnv(rows: { spent: number; calls: number; today: number } | null): Env {
  return {
    DB: {
      prepare: () => ({
        bind: () => ({ first: async () => rows }),
        run: async () => ({}),
      }),
    },
  } as unknown as Env;
}

describe('千问花费', () => {
  it('汇总最近 30 天', async () => {
    const s = await readQwenSpend(fakeEnv({ spent: 1.2345, calls: 42, today: 0.12 }));
    expect(s.spent).toBeCloseTo(1.2345);
    expect(s.calls).toBe(42);
    expect(s.spentToday).toBeCloseTo(0.12);
  });

  it('查不到就返回 0，不抛', async () => {
    const s = await readQwenSpend(fakeEnv(null));
    expect(s).toEqual({ spent: 0, spentToday: 0, calls: 0 });
  });
});

describe('千问余额信息', () => {
  it('没配 AccessKey 时说明原因，不编余额', async () => {
    const q = await qwenBalanceInfo(fakeEnv({ spent: 2, calls: 10, today: 0 }));
    expect(q.configured).toBe(false);
    expect(q.total).toBeNull();
    expect(q.label).toContain('千问本月');
    expect(q.hint).toContain('AccessKey');
  });
});
