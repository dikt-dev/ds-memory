import { describe, expect, it } from 'vitest';
import {
  consumePendingRecall,
  looksLikePinRequest,
  looksLikeConfirmation,
  recordRecallConfirmation,
  setChunkPinned,
} from './memory-rehearsal';
import type { Env } from './types';

function fakeEnv(initial: Record<string, string> = {}) {
  const kv = new Map(Object.entries(initial));
  const updates: unknown[][] = [];
  const env = {
    KV: {
      get: async (k: string) => kv.get(k) ?? null,
      put: async (k: string, v: string) => {
        kv.set(k, v);
      },
      delete: async (k: string) => {
        kv.delete(k);
      },
    },
    DB: {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => ({
          run: async () => {
            updates.push([sql.includes('confirmed_count') ? 'confirm' : 'pin', ...args]);
            return { success: true, meta: { changes: 1 } };
          },
        }),
      }),
    },
  } as unknown as Env;
  return { env, kv, updates };
}

describe('looksLikeConfirmation', () => {
  it('明确的回忆确认', () => {
    for (const t of ['对，就是那次', '记得', '是啊', '嗯，对', '没错就是它', '确实']) {
      expect(looksLikeConfirmation(t)).toBe(true);
    }
  });

  it('短促肯定也算', () => {
    for (const t of ['对', '嗯', '是的', '对对', '哈哈对']) {
      expect(looksLikeConfirmation(t)).toBe(true);
    }
  });

  it('长句不当作确认（避免随口附和被算成回忆确认）', () => {
    expect(looksLikeConfirmation('对啊我今天加班到十点才回家，累死了，明天还要早起去公司开会呢')).toBe(false);
  });

  it('否定与无关的话不算', () => {
    expect(looksLikeConfirmation('不是')).toBe(false);
    expect(looksLikeConfirmation('今天天气不错')).toBe(false);
    expect(looksLikeConfirmation('')).toBe(false);
  });
});

describe('consumePendingRecall', () => {
  const now = Date.parse('2026-10-31T20:00:00+08:00');

  it('确认后给上一轮的条目 +1 确认', async () => {
    const { env, updates, kv } = fakeEnv({
      'recall:pending': JSON.stringify({ ids: ['a', 'b'], at: now - 60_000 }),
    });
    const n = await consumePendingRecall(env, '对，就是那次', now);
    expect(n).toBe(2);
    expect(updates[0][0]).toBe('confirm');
    expect(kv.has('recall:pending')).toBe(false);
  });

  it('不是确认就什么都不做', async () => {
    const { env, updates } = fakeEnv({
      'recall:pending': JSON.stringify({ ids: ['a'], at: now }),
    });
    expect(await consumePendingRecall(env, '今天好累', now)).toBe(0);
    expect(updates).toEqual([]);
  });

  it('超过一小时的"对"不算', async () => {
    const { env } = fakeEnv({
      'recall:pending': JSON.stringify({ ids: ['a'], at: now - 2 * 3600_000 }),
    });
    expect(await consumePendingRecall(env, '对', now)).toBe(0);
  });

  it('没有待确认记录时安全返回', async () => {
    const { env } = fakeEnv();
    expect(await consumePendingRecall(env, '对', now)).toBe(0);
  });
});

describe('recordRecallConfirmation', () => {
  it('去重后一次更新，并同时算一次普通复习', async () => {
    const { env, updates } = fakeEnv();
    const n = await recordRecallConfirmation(env, ['a', 'a', 'b'], 123);
    expect(n).toBe(2);
    expect(updates[0]).toEqual(['confirm', 123, 'a', 'b']);
  });

  it('写失败返回 0', async () => {
    const env = { DB: { prepare: () => { throw new Error('down'); } } } as unknown as Env;
    expect(await recordRecallConfirmation(env, ['a'])).toBe(0);
  });
});

describe('setChunkPinned', () => {
  it('上锁返回是否命中', async () => {
    const { env, updates } = fakeEnv();
    expect(await setChunkPinned(env, 'c1', true)).toBe(true);
    expect(updates[0]).toEqual(['pin', 1, 'c1']);
  });

  it('数据库异常时返回 false 而不是抛', async () => {
    const env = { DB: { prepare: () => { throw new Error('down'); } } } as unknown as Env;
    expect(await setChunkPinned(env, 'c1', true)).toBe(false);
  });
});

describe('looksLikePinRequest', () => {
  it('明确的"记住这件事"', () => {
    for (const s of ['记住这件事', '别忘了这个', '这个很重要', '你要记得']) {
      expect(looksLikePinRequest(s)).toBe(true);
    }
  });

  it('长句和随口一说都不算', () => {
    expect(looksLikePinRequest('我记住了，今天开会讲了好多东西要整理一下，明天再和你说')).toBe(false);
    expect(looksLikePinRequest('今天天气不错')).toBe(false);
    expect(looksLikePinRequest('')).toBe(false);
  });
});
