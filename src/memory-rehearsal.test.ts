import { describe, expect, it } from 'vitest';
import { importanceFactor, rankMemoryChunks, recallDecay, rehearsalBoost, type MemoryChunk } from './memory-domain';
import { pickDormant, recordRecallUsage } from './memory-rehearsal';
import type { Env } from './types';

function chunk(over: Partial<MemoryChunk> = {}): MemoryChunk {
  return {
    id: 'c1',
    source: 'event',
    sourceId: 'e1',
    section: '共同经历',
    content: '一起看完了可塑性记忆',
    date: '2026-01-01',
    keywords: ['可塑性记忆'],
    tags: [],
    importance: 3,
    contentHash: 'h',
    updatedAt: 0,
    useCount: 0,
    ...over,
  };
}

describe('rehearsalBoost', () => {
  it('没复习过是 1 倍', () => {
    expect(rehearsalBoost(0)).toBe(1);
    expect(rehearsalBoost(undefined)).toBe(1);
  });

  it('复习次数越多半衰期越长，但对数增长', () => {
    const b1 = rehearsalBoost(1);
    const b3 = rehearsalBoost(3);
    const b10 = rehearsalBoost(10);
    expect(b1).toBeGreaterThan(1);
    expect(b3).toBeGreaterThan(b1);
    expect(b10).toBeGreaterThan(b3);
    // 每多复习一次的边际收益递减
    expect(rehearsalBoost(2) - rehearsalBoost(1)).toBeGreaterThan(
      rehearsalBoost(4) - rehearsalBoost(3),
    );
  });

  it('封顶 3 倍', () => {
    expect(rehearsalBoost(10000)).toBe(3);
  });
});

describe('importanceFactor', () => {
  it('1~5 映射到 0.85~1.2，3 是中性', () => {
    expect(importanceFactor(1)).toBeCloseTo(0.8, 2);
    expect(importanceFactor(5)).toBeCloseTo(1.2, 2);
    expect(importanceFactor(3)).toBeCloseTo(1, 2);
  });
});

describe('recallDecay 的复习效应', () => {
  const now = Date.parse('2026-10-31T12:00:00+08:00');

  it('同样老，复习过的衰减更少', () => {
    const fresh = recallDecay(chunk({ date: '2026-01-01', useCount: 0 }), now);
    const rehearsed = recallDecay(chunk({ date: '2026-01-01', useCount: 10 }), now);
    expect(rehearsed).toBeGreaterThan(fresh);
  });

  it('核心区永不衰减', () => {
    expect(recallDecay(chunk({ section: '人物底色', date: '2020-01-01' }), now)).toBe(1);
  });

  it('衰减有下限 0.15', () => {
    expect(recallDecay(chunk({ date: '2010-01-01' }), now)).toBeGreaterThanOrEqual(0.15);
  });
});

describe('rankMemoryChunks 把重要性与复习算进去', () => {
  const now = Date.parse('2026-10-31T12:00:00+08:00');
  it('同关键词下，重要且被复习过的旧事排前面', () => {
    const trivial = chunk({ id: 'a', content: '奶茶', keywords: ['奶茶'], importance: 1, date: '2026-06-01' });
    const milestone = chunk({ id: 'b', content: '奶茶', keywords: ['奶茶'], importance: 5, date: '2026-06-01', useCount: 8 });
    const ranked = rankMemoryChunks('奶茶', [trivial, milestone], 2);
    expect(ranked[0].id).toBe('b');
  });
});

describe('pickDormant', () => {
  const now = Date.parse('2026-10-31T12:00:00+08:00');
  it('挑很久没提过、有点分量的旧事', () => {
    const old = chunk({ id: 'old', date: '2026-03-01', importance: 4 });
    const fresh = chunk({ id: 'fresh', date: '2026-10-28', importance: 4 });
    expect(pickDormant([fresh, old], now, { random: () => 0.5 })?.id).toBe('old');
  });

  it('总被复习的不算沉睡', () => {
    const used = chunk({ id: 'used', date: '2026-03-01', useCount: 9 });
    expect(pickDormant([used], now)).toBeNull();
  });

  it('太琐碎的不翻出来', () => {
    expect(pickDormant([chunk({ date: '2026-03-01', importance: 1 })], now)).toBeNull();
  });

  it('没有候选返回 null', () => {
    expect(pickDormant([], now)).toBeNull();
  });
});

describe('recordRecallUsage', () => {
  it('把 id 去重后一次更新', async () => {
    const calls: unknown[][] = [];
    const env = {
      DB: {
        prepare: () => ({
          bind: (...args: unknown[]) => ({ run: async () => { calls.push(args); return { success: true }; } }),
        }),
      },
    } as unknown as Env;
    const n = await recordRecallUsage(env, ['a', 'a', 'b'], 123);
    expect(n).toBe(2);
    expect(calls[0]).toEqual([123, 'a', 'b']);
  });

  it('写失败不影响调用方', async () => {
    const env = { DB: { prepare: () => { throw new Error('db down'); } } } as unknown as Env;
    await expect(recordRecallUsage(env, ['a'])).resolves.toBe(0);
  });

  it('空数组直接返回 0', async () => {
    const env = {} as Env;
    await expect(recordRecallUsage(env, [])).resolves.toBe(0);
  });
});
