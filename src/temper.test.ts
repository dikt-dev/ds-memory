import { describe, expect, it } from 'vitest';
import { computeTemper } from './temper';
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