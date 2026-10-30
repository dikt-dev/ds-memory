import { afterEach, describe, expect, it, vi } from 'vitest';
import { getStatusSnapshot } from './status';
import type { Env } from './types';

/** 状态页只回模糊的一句话，测试锁的是「什么情况下说哪句话」。 */
function fakeEnv(opts: { memory?: string; todayCount?: number; emotion?: unknown } = {}) {
  const memory = opts.memory ?? '';
  const kv = new Map<string, string>();
  if (opts.emotion) kv.set('emotion:state', JSON.stringify(opts.emotion));
  kv.set('memory:cache', memory);
  const env = {
    KV: {
      get: async (k: string) => (kv.has(k) ? kv.get(k)! : null),
      put: async (k: string, v: string) => void kv.set(k, v),
      delete: async (k: string) => void kv.delete(k),
    },
    R2: { get: async () => null, put: async () => undefined },
    DB: {
      prepare: () => ({
        bind: () => ({ first: async () => ({ c: opts.todayCount ?? 0 }) }),
        first: async () => ({ c: opts.todayCount ?? 0 }),
      }),
    },
    DEEPSEEK_API_KEY: '',
  } as unknown as Env;
  return env;
}

afterEach(() => vi.unstubAllGlobals());

describe('getStatusSnapshot —— 状态只给模糊的一句话', () => {
  it('没有数据时说「还算平常」，不给数字', async () => {
    const snap = await getStatusSnapshot(fakeEnv());
    expect(snap.mood.label).toBe('还算平常');
    // 关系值有出厂默认（她一开始就已经很亲近），没有记忆文件也不会掉到「还不太熟」
    expect(snap.relation.label.length).toBeGreaterThan(0);
    expect(snap.memory.label).toBe('刚开始记');
    expect(snap.today.label).toBe('今天还没说话');
    expect(snap.balance).toBeNull();
    expect(JSON.stringify(snap)).not.toMatch(/\b\d{2,3}\b.*心情/);
  });

  it('生气时情绪盖过其它状态', async () => {
    const snap = await getStatusSnapshot(fakeEnv({
      emotion: { vector: { valence: 10, grievance: 50, fatigue: 0 }, events: [], facetDelta: {}, at: Date.now() },
    }));
    expect(snap.mood.label).toBe('还在生气');
  });

  it('累了就说累了', async () => {
    const snap = await getStatusSnapshot(fakeEnv({
      emotion: { vector: { valence: 0, grievance: 0, fatigue: 70 }, events: [], facetDelta: {}, at: Date.now() },
    }));
    expect(snap.mood.label).toBe('累了');
  });

  it('心情好', async () => {
    const snap = await getStatusSnapshot(fakeEnv({
      emotion: { vector: { valence: 30, grievance: 0, fatigue: 0 }, events: [], facetDelta: {}, at: Date.now() },
    }));
    expect(snap.mood.label).toBe('心情很好');
  });

  it('今天聊得多会被说成「聊了挺多」', async () => {
    const snap = await getStatusSnapshot(fakeEnv({ todayCount: 80 }));
    expect(snap.today.label).toBe('今天聊了挺多');
  });

  it('记忆越多说法越暖', async () => {
    const small = await getStatusSnapshot(fakeEnv({ memory: 'x'.repeat(2000) }));
    const big = await getStatusSnapshot(fakeEnv({ memory: 'x'.repeat(20000) }));
    expect(small.memory.label).toBe('还记着一些');
    expect(big.memory.label).toBe('记得挺多');
  });

  it('关系按亲密度分档', async () => {
    const memory = ['## 关系', '- 亲密度：80', '- 好感度：70', '- 信任度：70'].join('\n');
    const snap = await getStatusSnapshot(fakeEnv({ memory }));
    expect(['黏得很', '很亲近', '挺熟的', '还不太熟']).toContain(snap.relation.label);
  });

  it('余额查得到时给档位和金额', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      balance_infos: [{ currency: 'CNY', total_balance: '12.34' }],
    }), { status: 200 })));
    const env = fakeEnv();
    (env as unknown as Record<string, unknown>).DEEPSEEK_API_KEY = 'sk-test';
    const snap = await getStatusSnapshot(env);
    expect(snap.balance?.label).toBe('还够用一阵');
    expect(snap.balance?.total).toBeCloseTo(12.34);
  });

  it('余额接口挂掉不影响其它状态', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    const env = fakeEnv();
    (env as unknown as Record<string, unknown>).DEEPSEEK_API_KEY = 'sk-test';
    const snap = await getStatusSnapshot(env);
    expect(snap.balance).toBeNull();
    expect(snap.mood.label).toBeTruthy();
  });
});