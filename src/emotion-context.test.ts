import { describe, expect, it } from 'vitest';
import type { Env } from './types';
import {
  commitEmotionSettle,
  effectiveFacets,
  emptyEmotionState,
  loadEmotionState,
  processEmotionTurn,
  saveEmotionState,
  settleEmotionDaily,
  trimEvents,
} from './emotion-context';
import { FACET_DEFAULTS, type RelationFacets } from './relation-facets';

/** 极简 KV 假实现（只要 get / put / delete）。 */
class FakeKV {
  store = new Map<string, string>();
  puts = 0;
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async put(key: string, value: string): Promise<void> {
    this.puts += 1;
    this.store.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

function fakeEnv(): { env: Env; kv: FakeKV } {
  const kv = new FakeKV();
  return { env: { KV: kv } as unknown as Env, kv };
}

const T0 = Date.UTC(2026, 9, 23, 12, 0, 0);
const base: RelationFacets = { ...FACET_DEFAULTS };

describe('loadEmotionState / saveEmotionState', () => {
  it('空 KV 返回中性状态', async () => {
    const { env } = fakeEnv();
    const state = await loadEmotionState(env, T0);
    expect(state.vector.grievance).toBe(0);
    expect(state.events).toEqual([]);
  });

  it('存了再读，按经过时间衰减', async () => {
    const { env } = fakeEnv();
    await saveEmotionState(env, {
      vector: { ...emptyEmotionState(T0).vector, shyness: 80 },
      events: [],
      facetDelta: {},
      at: T0,
    });
    const later = await loadEmotionState(env, T0 + 15 * 60_000);
    expect(later.vector.shyness).toBe(40); // 15 分钟 = 1 个半衰期
  });

  it('脏 JSON 不炸，回退中性', async () => {
    const { env, kv } = fakeEnv();
    kv.store.set('emotion:state', '{not json');
    const state = await loadEmotionState(env, T0);
    expect(state.vector.valence).toBe(0);
  });
});

describe('processEmotionTurn —— 一轮对话的完整链路', () => {
  it('被骂：委屈上升 + 尊重下降', async () => {
    const { env } = fakeEnv();
    const r = await processEmotionTurn({
      env,
      now: T0,
      base,
      userText: '你懂什么，废物',
    });
    expect(r.state.vector.grievance).toBeGreaterThan(0);
    expect(r.facets.respect).toBeLessThan(base.respect);
    expect(r.snapshot).toContain('委屈');
  });

  it('道歉：委屈回落，事件被标记为已化解', async () => {
    const { env } = fakeEnv();
    await processEmotionTurn({ env, now: T0, base, userText: '你懂什么' });
    const after = await processEmotionTurn({
      env,
      now: T0 + 60_000,
      base,
      userText: '对不起，是我不好',
    });
    expect(after.state.vector.grievance).toBeLessThan(30);
    expect(after.state.events.every((e) => e.resolved)).toBe(true);
    expect(after.snapshot).not.toContain('还没过去');
  });

  it('普通闲聊不写 KV（脏检查）', async () => {
    const { env, kv } = fakeEnv();
    await processEmotionTurn({ env, now: T0, base, userText: '今天几号' });
    expect(kv.puts).toBe(0);
  });

  it('开了 AI 复核也不该让闲聊加锁（否则每条消息两次 KV 写）', async () => {
    const { env, kv } = fakeEnv();
    await processEmotionTurn({ env, now: T0, base, userText: '今天几号', allowAiReview: true });
    expect(kv.puts).toBe(0);
  });

  it('聊久了会累', async () => {
    const { env } = fakeEnv();
    await saveEmotionState(env, emptyEmotionState(T0 - 90 * 60_000));
    const long = await processEmotionTurn({ env, now: T0, base, userText: '在吗' });
    expect(long.state.vector.fatigue).toBeGreaterThan(0);
  });

  it('刚聊完一句不会累', async () => {
    const { env } = fakeEnv();
    await saveEmotionState(env, emptyEmotionState(T0 - 2 * 60_000));
    const quick = await processEmotionTurn({ env, now: T0, base, userText: '在吗' });
    expect(quick.state.vector.fatigue).toBe(0);
  });

  it('冷落会追加一条 ignored 事件', async () => {
    const { env } = fakeEnv();
    const r = await processEmotionTurn({
      env,
      now: T0,
      base,
      userText: '',
      wasIgnored: true,
    });
    expect(r.state.events.some((e) => e.type === 'ignored')).toBe(true);
    expect(r.snapshot).toContain('小情绪');
  });

  it('环境会独立影响情绪（有来源）', async () => {
    const { env } = fakeEnv();
    const r = await processEmotionTurn({
      env,
      now: T0,
      base,
      userText: '',
      environment: { hour: 3, isRestDay: false, weather: null, month: 10 },
    });
    // 首次（距上次 0 分钟）按 0 折算，不叠加；这里断言不报错且值合法
    expect(r.state.vector.fatigue).toBeGreaterThanOrEqual(0);
  });

  it('事件池最多 30 条', async () => {
    const { env } = fakeEnv();
    let now = T0;
    for (let i = 0; i < 40; i++) {
      now += 60_000;
      await processEmotionTurn({ env, now, base, userText: '你懂什么' });
    }
    const state = await loadEmotionState(env, now);
    expect(state.events.length).toBeLessThanOrEqual(30);
  });
});

describe('effectiveFacets / settleEmotionDaily', () => {
  it('基准 + 累积增量', () => {
    const f = effectiveFacets(base, { affection: 2, trust: -3 });
    expect(f.affection).toBe(base.affection + 2);
    expect(f.trust).toBe(base.trust - 3);
  });

  it('结算按单日上限截断，超出部分丢弃', () => {
    const state = { ...emptyEmotionState(T0), facetDelta: { affection: 99, trust: -99 } };
    const settled = settleEmotionDaily(state, base);
    expect(settled.applied.affection).toBe(8);
    expect(settled.applied.trust).toBe(-6);
    expect(settled.facets.affection).toBe(base.affection + 8);
  });

  it('无变化时 changed=false', () => {
    const settled = settleEmotionDaily(emptyEmotionState(T0), base);
    expect(settled.changed).toBe(false);
  });

  it('commitEmotionSettle 清空增量；疙瘩都没了，芥蒂退 15%（2026-11-10）', async () => {
    const { env } = fakeEnv();
    await saveEmotionState(env, {
      vector: { ...emptyEmotionState(T0).vector, grievance: 50 },
      events: [],
      facetDelta: { affection: 3 },
      at: T0,
    });
    const state = await loadEmotionState(env, T0);
    await commitEmotionSettle(env, state);
    const after = await loadEmotionState(env, T0);
    expect(after.facetDelta).toEqual({});
    expect(after.vector.grievance).toBe(43);
  });

  it('还有没过去的疙瘩时只退 4%——等他哄', async () => {
    const { env } = fakeEnv();
    await saveEmotionState(env, {
      vector: { ...emptyEmotionState(T0).vector, grievance: 50 },
      events: [
        { type: 'insult', intensity: 3, target: 'ai', evidence: '你懂什么', at: Date.now() - 60_000, resolved: false },
      ],
      facetDelta: {},
      at: T0,
    });
    const state = await loadEmotionState(env, T0);
    await commitEmotionSettle(env, state);
    const after = await loadEmotionState(env, T0);
    expect(after.vector.grievance).toBe(48);
  });
});

describe('事件池裁剪（E-05）', () => {
  const ev = (type: string, at: number, resolved = false) => ({
    type: type as never,
    intensity: 1 as const,
    target: 'ai' as const,
    evidence: '',
    at,
    resolved,
  });

  it('未化解的负向事件不会被挤出池子', () => {
    const oldGrievance = ev('insult', 1);
    const filler = Array.from({ length: 40 }, (_, i) => ev('praise', 100 + i));
    const trimmed = trimEvents([oldGrievance, ...filler]);
    expect(trimmed.some((e) => e.at === 1)).toBe(true);
  });

  it('已化解的负向事件照常参与裁剪', () => {
    const resolved = ev('insult', 1, true);
    const filler = Array.from({ length: 40 }, (_, i) => ev('praise', 100 + i));
    const trimmed = trimEvents([resolved, ...filler]);
    expect(trimmed.some((e) => e.at === 1)).toBe(false);
  });
});
