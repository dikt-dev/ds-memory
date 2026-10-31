import { describe, expect, it } from 'vitest';
import { factKey, planExpiry, type FactKeyRow } from './fact-expiry';
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
