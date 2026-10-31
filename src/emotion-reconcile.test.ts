import { describe, expect, it } from 'vitest';
import {
  grievanceTrustPenalty,
  missedSettleRounds,
  saveEmotionHistory,
} from './emotion-context';
import { sumPendingFacetDelta } from './affect-store';
import { emptyEmotionVector } from './emotion-vector';
import type { Env } from './types';

const DAY = 86_400_000;

describe('missedSettleRounds —— E-16 结算兜底', () => {
  it('当天正常跑过就不补', () => {
    expect(missedSettleRounds(0, 0)).toBe(0);
    expect(missedSettleRounds(Date.now() - 3_600_000, Date.now())).toBe(0);
  });

  it('漏了几天就补几天', () => {
    const now = 10 * DAY;
    expect(missedSettleRounds(now - 2.5 * DAY, now)).toBe(2);
    expect(missedSettleRounds(now - 5 * DAY, now)).toBe(5);
  });

  it('补跑上限 7 天，防止一次算爆', () => {
    expect(missedSettleRounds(0, 100 * DAY, 7)).toBe(0);
    expect(missedSettleRounds(100 * DAY - 30 * DAY, 100 * DAY)).toBe(7);
  });

  it('时间戳异常时不动', () => {
    expect(missedSettleRounds(Number.NaN, Date.now())).toBe(0);
    expect(missedSettleRounds(-1, Date.now())).toBe(0);
  });
});

describe('grievanceTrustPenalty —— E-10 芥蒂联动信任', () => {
  it('没有委屈不扣', () => {
    expect(grievanceTrustPenalty({ ...emptyEmotionVector(), grievance: 0 })).toBe(0);
    expect(grievanceTrustPenalty({ ...emptyEmotionVector(), grievance: 19 })).toBe(0);
  });

  it('委屈越高扣得越多，但每天封顶 -2', () => {
    expect(grievanceTrustPenalty({ ...emptyEmotionVector(), grievance: 40 })).toBeCloseTo(-1.2);
    expect(grievanceTrustPenalty({ ...emptyEmotionVector(), grievance: 100 })).toBe(-2);
    expect(grievanceTrustPenalty({ ...emptyEmotionVector(), grievance: 300 })).toBe(-2);
  });
});

describe('sumPendingFacetDelta —— E-15 账本对账', () => {
  const fakeDb = (rows: Array<{ delta_json: string }>) =>
    ({
      DB: {
        prepare: () => ({
          bind: () => ({ all: async () => ({ results: rows }) }),
        }),
      },
    }) as unknown as Env;

  it('账本为空返回 null（没有可对账的东西）', async () => {
    expect(await sumPendingFacetDelta(fakeDb([]), 0)).toBeNull();
  });

  it('多行增量按轴求和', async () => {
    const env = fakeDb([
      { delta_json: '{"trust":-1,"affection":2}' },
      { delta_json: '{"trust":-2}' },
      { delta_json: 'not json' },
    ]);
    expect(await sumPendingFacetDelta(env, 0)).toEqual({ trust: -3, affection: 2 });
  });

  it('查询报错时返回 null（不影响归档继续）', async () => {
    const env = {
      DB: { prepare: () => { throw new Error('d1 down'); } },
    } as unknown as Env;
    expect(await sumPendingFacetDelta(env, 0)).toBeNull();
  });
});

describe('saveEmotionHistory —— E-11 情绪日线', () => {
  function fakeEnv() {
    const store = new Map<string, string>();
    const env = {
      R2: {
        put: async (k: string, v: string) => { store.set(k, String(v)); },
      },
    } as unknown as Env;
    return { env, store };
  }

  it('按日期写一份，含向量与面子值', async () => {
    const { env, store } = fakeEnv();
    const ok = await saveEmotionHistory(env, '2026-10-31', {
      vector: { ...emptyEmotionVector(), grievance: 12 },
      facets: { affection: 685, intimacy: 567, trust: 605, respect: 639, attraction: 314 },
      mood: 464,
    });
    expect(ok).toBe(true);
    const saved = JSON.parse(store.get('memory/emotion-history/2026-10-31.json')!);
    expect(saved.date).toBe('2026-10-31');
    expect(saved.mood).toBe(464);
    expect(saved.vector.grievance).toBe(12);
  });

  it('写失败返回 false，不抛异常', async () => {
    const env = { R2: { put: async () => { throw new Error('r2 down'); } } } as unknown as Env;
    expect(await saveEmotionHistory(env, '2026-10-31', {
      vector: emptyEmotionVector(),
      facets: { affection: 0, intimacy: 0, trust: 0, respect: 0, attraction: 0 },
      mood: 0,
    })).toBe(false);
  });
});
