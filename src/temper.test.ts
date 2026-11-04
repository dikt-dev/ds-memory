import { describe, expect, it } from 'vitest';
import { computeTemper, temperCause } from './temper';
import { emptyEmotionVector } from './emotion-vector';
import { FACET_DEFAULTS, type RelationFacets } from './relation-facets';

const facets: RelationFacets = { ...FACET_DEFAULTS, intimacy: 80 };

describe('computeTemper', () => {
  it('心情好、关系近 → warm，且不因此不许拒绝', () => {
    const v = { ...emptyEmotionVector(), valence: 70, attachment: 70 };
    const t = computeTemper({ vector: v, facets });
    expect(t.stance).toBe('warm');
    expect(t.allowRefuse).toBe(false);
  });

  it('只是心情不好也能拒绝（不需要被冒犯过）', () => {
    const v = { ...emptyEmotionVector(), valence: -25, attachment: 40 };
    const t = computeTemper({ vector: v, facets });
    expect(t.allowRefuse).toBe(true);
  });

  it('累了也能拒绝', () => {
    const v = { ...emptyEmotionVector(), valence: 10, fatigue: 60 };
    expect(computeTemper({ vector: v, facets }).allowRefuse).toBe(true);
  });

  it('没被得罪、心情平常时不许拿脾气挡正常请求', () => {
    const v = { ...emptyEmotionVector(), valence: 15, attachment: 30 };
    expect(computeTemper({ vector: v, facets }).allowRefuse).toBe(false);
  });

  it('芥蒂很高 → cold，且允许直接拒绝', () => {
    const v = { ...emptyEmotionVector(), grievance: 85, valence: -30 };
    const t = computeTemper({ vector: v, facets });
    expect(t.stance).toBe('cold');
    expect(t.allowRefuse).toBe(true);
    expect(t.line).toContain('拒绝');
  });

  it('委屈越多，配合度越低（单调）', () => {
    const base = { ...emptyEmotionVector(), valence: 20 };
    const a = computeTemper({ vector: { ...base, grievance: 10 }, facets }).compliance;
    const b = computeTemper({ vector: { ...base, grievance: 50 }, facets }).compliance;
    const c = computeTemper({ vector: { ...base, grievance: 90 }, facets }).compliance;
    expect(a).toBeGreaterThan(b);
    expect(b).toBeGreaterThan(c);
  });

  it('被冷落会再降一点', () => {
    const v = { ...emptyEmotionVector(), attachment: 50 };
    const no = computeTemper({ vector: v, facets }).compliance;
    const yes = computeTemper({ vector: v, facets, wasIgnored: true }).compliance;
    expect(yes).toBeLessThan(no);
  });

  it('配合度永远在 0~1 之间（极端值不会溢出）', () => {
    const bad = computeTemper({
      vector: { ...emptyEmotionVector(), grievance: 100, fatigue: 100, dominance: -100, valence: -100 },
      facets: { ...FACET_DEFAULTS, intimacy: 0 },
      wasIgnored: true,
    });
    expect(bad.compliance).toBeGreaterThanOrEqual(0);
    expect(bad.compliance).toBeLessThanOrEqual(1);
    const good = computeTemper({
      vector: { ...emptyEmotionVector(), valence: 100, attachment: 100 },
      facets: { ...FACET_DEFAULTS, intimacy: 100 },
    });
    expect(good.compliance).toBeLessThanOrEqual(1);
  });
});

describe('归因', () => {
  const now = 1_760_000_000_000;
  const ev = (type: any, at = now - 60_000) => ({
    type,
    intensity: 2 as const,
    target: 'ai' as const,
    evidence: '你懂什么',
    at,
  });

  it('心情差 + 刚被呛 → 句子里带上原因', () => {
    const v = { ...emptyEmotionVector(), grievance: 60, valence: -30 };
    const t = computeTemper({ vector: v, facets, events: [ev('insult')], now });
    expect(t.stance === 'cold' || t.stance === 'cool').toBe(true);
    expect(t.line).toContain('因为他刚才那句话有点冲');
    expect(t.cause).toBe('他刚才那句话有点冲');
  });

  it('心情好 + 刚被夸 → 用正向事件归因', () => {
    const v = { ...emptyEmotionVector(), valence: 60, attachment: 70 };
    const t = computeTemper({ vector: v, facets, events: [ev('praise')], now });
    expect(t.line).toContain('因为他刚夸了你');
  });

  it('没有事件就不硬编原因', () => {
    const v = { ...emptyEmotionVector(), valence: -25, grievance: 30 };
    const t = computeTemper({ vector: v, facets, events: [], now });
    expect(t.cause).toBeNull();
    expect(t.line).not.toContain('因为');
  });

  it('超出 6 小时的旧事不再当理由', () => {
    expect(temperCause([ev('insult', now - 7 * 3600_000)], now, 'cool')).toBeNull();
  });
});
