import { describe, expect, it } from 'vitest';
import { factKey, planExpiry,
  planIdenticalMerges, type FactKeyRow } from './fact-expiry';
import type { MemoryFact } from './memory-domain';

function fact(over: Partial<MemoryFact> = {}): MemoryFact {
  return {
    id: 'f1',
    section: '基本信息',
    content: '城市=成都',
    subject: '城市',
    predicate: '居住',
    object: '成都',
    validFrom: '2026-10-31',
    validTo: null,
    confidence: 1,
    sourceMessageIds: [1301],
    tags: [],
    contentHash: 'h',
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

function row(over: Partial<FactKeyRow> = {}): FactKeyRow {
  return {
    id: 'old-1',
    subject: '城市',
    predicate: '居住',
    object: '北京',
    valid_from: '2025-01-01',
    valid_to: null,
    ...over,
  };
}

const NOW = '2026-10-31';

describe('factKey', () => {
  it('subject + predicate 都要有才算可判定', () => {
    expect(factKey({ subject: '城市', predicate: '居住' })).toBeTruthy();
    expect(factKey({ subject: '城市', predicate: null })).toBeNull();
    expect(factKey({ subject: null, predicate: '居住' })).toBeNull();
  });

  it('大小写与空白归一', () => {
    expect(factKey({ subject: ' City ', predicate: 'Lives' })).toBe(
      factKey({ subject: 'city', predicate: 'lives' }),
    );
  });
});

describe('planExpiry', () => {
  it('新旧值不同 → 旧事实失效，指向新事实', () => {
    const steps = planExpiry([row()], [fact()], NOW);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ id: 'old-1', validTo: '2026-10-31', supersededBy: 'f1' });
  });

  it('值相同 → 视为同一事实重复出现，不失效', () => {
    expect(planExpiry([row({ object: '成都' })], [fact()], NOW)).toEqual([]);
  });

  it('已经失效过的旧事实不再重复处理', () => {
    expect(planExpiry([row({ valid_to: '2026-01-01' })], [fact()], NOW)).toEqual([]);
  });

  it('没有 subject/predicate 的事实不参与冲突', () => {
    const loose = fact({ subject: null, predicate: null });
    expect(planExpiry([row()], [loose], NOW)).toEqual([]);
  });

  it('同批次两条同 key 的新事实，后者顶掉前者', () => {
    const a = fact({ id: 'a', object: '北京', validTo: null });
    const b = fact({ id: 'b', object: '成都' });
    const steps = planExpiry([], [a, b], NOW);
    expect(steps.map((s) => s.id)).toEqual(['a']);
    expect(steps[0].supersededBy).toBe('b');
  });

  it('自己不会失效自己', () => {
    const self = fact({ id: 'old-1' });
    expect(planExpiry([row({ id: 'old-1' })], [self], NOW)).toEqual([]);
  });

  it('新事实没写 validFrom 时用当下时间', () => {
    const noDate = fact({ validFrom: null });
    expect(planExpiry([row()], [noDate], NOW)[0].validTo).toBe(NOW);
  });

  it('大小写不同的 key 也能命中', () => {
    const steps = planExpiry([row({ subject: 'CITY', predicate: 'Lives' })], [fact({ subject: 'city', predicate: 'lives' })], NOW);
    expect(steps).toHaveLength(1);
  });
});


describe('planIdenticalMerges（同一事实只留一条）', () => {
  const row = (over = {}) => ({
    id: 'old-1',
    subject: '城市',
    predicate: '城市',
    object: '杭州',
    valid_from: '2026-10-01',
    valid_to: null,
    source_message_ids: '[1,2]',
    confidence: 0.6,
    ...over,
  });
  const fact = (over = {}) => ({
    id: 'new-1',
    section: '关于用户',
    content: '城市=杭州',
    subject: '城市',
    predicate: '城市',
    object: '杭州',
    validFrom: '2026-11-02',
    validTo: null,
    confidence: 0.8,
    sourceMessageIds: [9],
    tags: [],
    contentHash: 'x',
    createdAt: 1,
    updatedAt: 1,
    ...over,
  });

  it('值相同：不出新行，出处合并、置信度取高', () => {
    const { updates, skip } = planIdenticalMerges([row()], [fact()], 1000);
    expect(skip).toEqual(['new-1']);
    expect(updates).toHaveLength(1);
    expect(updates[0].id).toBe('old-1');
    expect(updates[0].sourceMessageIds).toEqual([1, 2, 9]);
    expect(updates[0].confidence).toBe(0.8);
    expect(updates[0].validFrom).toBe('2026-10-01');
  });

  it('值不同：不合并，交给失效链', () => {
    const { updates, skip } = planIdenticalMerges([row({ object: '上海' })], [fact()], 1000);
    expect(skip).toEqual([]);
    expect(updates).toEqual([]);
  });

  it('已失效的旧行不再接新事实', () => {
    const { skip } = planIdenticalMerges([row({ valid_to: '2026-10-20' })], [fact()], 1000);
    expect(skip).toEqual([]);
  });

  it('同批次重复出现也只并一次', () => {
    const { updates, skip } = planIdenticalMerges([row()], [fact({ id: 'a' }), fact({ id: 'b' })], 1000);
    expect(skip.sort()).toEqual(['a', 'b']);
    expect(updates).toHaveLength(1);
    expect(updates[0].sourceMessageIds).toEqual([1, 2, 9]);
  });
});
