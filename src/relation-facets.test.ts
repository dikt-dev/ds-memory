import { describe, expect, it } from 'vitest';
import {
  FACET_DEFAULTS,
  applyFacetDelta,
  facetsFromValues,
  formatFacets,
  relationArchetype,
  settleFacetDelta,
  type RelationFacets,
} from './relation-facets';

const base: RelationFacets = { ...FACET_DEFAULTS };

describe('relationArchetype —— 关系原型（轴背离才是重点）', () => {
  it('喜欢但不敢说真话', () => {
    const a = relationArchetype({ ...base, affection: 800, trust: 400, intimacy: 700 });
    expect(a.key).toBe('guarded');
    expect(a.label).toContain('留着一手');
  });

  it('亲近但没分寸', () => {
    const a = relationArchetype({ ...base, affection: 800, respect: 400, trust: 700, intimacy: 700 });
    expect(a.key).toBe('boundless');
  });

  it('暧昧未挑明', () => {
    const a = relationArchetype({ ...base, affection: 700, attraction: 700, trust: 700, respect: 700, intimacy: 600 });
    expect(a.key).toBe('ambiguous');
  });

  it('亲密 + 委屈 = 闹别扭（优先级高于普通亲密）', () => {
    const a = relationArchetype({ ...base, affection: 700, trust: 700, respect: 700, intimacy: 700 }, 50);
    expect(a.key).toBe('sulking');
  });

  it('委屈不高时不闹别扭', () => {
    const a = relationArchetype({ ...base, affection: 700, trust: 700, respect: 700, intimacy: 700 }, 10);
    expect(a.key).not.toBe('sulking');
  });

  it('熟但最近烦你', () => {
    const a = relationArchetype({ ...base, affection: 400, intimacy: 600, trust: 400, respect: 400 });
    expect(a.key).toBe('weary');
  });

  it('默认值就是新关系，不能被当成「熟悉而自然」', () => {
    const a = relationArchetype(base);
    expect(a.key).toBe('acquaintance');
  });

  it('陌生关系', () => {
    const a = relationArchetype({ ...base, affection: 200, intimacy: 200, trust: 300, respect: 400 });
    expect(a.key).toBe('distant');
  });
});

describe('applyFacetDelta —— 轮级微增量', () => {
  it('单轮单轴限幅 1.5', () => {
    const next = applyFacetDelta(base, { affection: 10 });
    expect(next.affection).toBeCloseTo(base.affection + 1.5, 5);
  });

  it('保留小数，便于跨轮累积', () => {
    const next = applyFacetDelta(base, { attraction: 0.8 });
    expect(next.attraction).toBeCloseTo(base.attraction + 0.8, 5);
  });

  it('不越界', () => {
    const next = applyFacetDelta({ ...base, respect: 0 }, { respect: -1.5 });
    expect(next.respect).toBe(0);
  });
});

describe('settleFacetDelta —— 天级结算', () => {
  it('按单日上限截断并取整', () => {
    const applied = settleFacetDelta({ affection: 12.4, trust: -20 });
    expect(applied.affection).toBe(5);
    expect(applied.trust).toBe(-4);
  });

  it('空增量全 0', () => {
    expect(settleFacetDelta({})).toEqual({ affection: 0, trust: 0, respect: 0, attraction: 0, intimacy: 0 });
  });
});

describe('facetsFromValues —— 旧数据平滑迁移', () => {
  it('旧三值补默认新轴', () => {
    const f = facetsFromValues({ affinity: 820, intimacy: 760 });
    expect(f.affection).toBe(820);
    expect(f.intimacy).toBe(760);
    expect(f.trust).toBe(600);
    expect(f.respect).toBe(650);
    expect(f.attraction).toBe(300);
  });

  it('已有新轴时优先使用', () => {
    const f = facetsFromValues({ affinity: 500, intimacy: 300, trust: 900 });
    expect(f.trust).toBe(900);
  });
});

describe('formatFacets', () => {
  it('输出五轴紧凑串', () => {
    expect(formatFacets({ ...base, affection: 780.4 })).toBe(
      '喜欢 780 / 信任 600 / 尊重 650 / 心动 300 / 熟悉 300',
    );
  });
});
