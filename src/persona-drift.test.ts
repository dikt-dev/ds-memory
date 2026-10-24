import { describe, expect, it } from 'vitest';
import {
  BASELINE,
  buildPersonaDriftLine,
  shouldReviewPersona,
  type PersonaState,
} from './persona-drift';

function state(overrides: Partial<PersonaState> = {}): PersonaState {
  return {
    values: { ...BASELINE },
    baseline: { ...BASELINE },
    updatedAt: '2026-10-24T00:00:00+08:00',
    lastReview: '2026-10-24',
    history: [],
    ...overrides,
  };
}

describe('persona drift line', () => {
  it('没有明显变化时不注入', () => {
    expect(buildPersonaDriftLine(state())).toBeNull();
  });

  it('只描述变化最大的两个维度，不暴露数值', () => {
    const s = state({
      values: { ...BASELINE, 傲娇: BASELINE.傲娇 + 4, 活泼: BASELINE.活泼 + 3, 温柔: BASELINE.温柔 - 2 },
    });
    const line = buildPersonaDriftLine(s);
    expect(line).toContain('更傲娇一点');
    expect(line).toContain('更活泼一点');
    expect(line).not.toContain('温柔');
    expect(line).not.toContain('78');
  });

  it('不足 7 天不结算', () => {
    const now = new Date('2026-10-27T12:00:00+08:00');
    expect(shouldReviewPersona(state({ lastReview: '2026-10-24' }), now)).toBe(false);
  });

  it('满 7 天且跨天时才结算', () => {
    const now = new Date('2026-10-31T12:00:00+08:00');
    expect(shouldReviewPersona(state({ lastReview: '2026-10-24' }), now)).toBe(true);
  });
});
