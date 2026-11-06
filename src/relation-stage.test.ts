import { describe, expect, it } from 'vitest';
import { closeness, stageFor, STAGE_LEVELS, FACET_DAILY_CAPS } from './relation-facets';

const base = { affection: 500, trust: 600, respect: 650, attraction: 300, intimacy: 300 };

describe('关系阶段', () => {
  it('closeness 以亲密为主、好感为辅', () => {
    expect(closeness(base)).toBe(390);
  });

  it('默认值是 Lv1 普通朋友', () => {
    expect(stageFor(base).level).toBe(1);
  });

  it('阈值边界可用', () => {
    expect(stageFor({ ...base, intimacy: 800, affection: 800, attraction: 700 }).level).toBe(4);
    expect(stageFor({ ...base, intimacy: 620, affection: 620, attraction: 300 }).level).toBe(3);
  });

  it('没有心动就停在好朋友', () => {
    const hot = { ...base, intimacy: 900, affection: 900, attraction: 400 };
    expect(stageFor(hot).level).toBe(3);
  });

  it('levelOverride 只用于迟滞，不会把阶段顶高', () => {
    expect(stageFor(base, 3).level).toBe(1);
    expect(stageFor({ ...base, intimacy: 800, affection: 800, attraction: 700 }, 1).level).toBe(1);
  });

  it('阶段表连续且 min 递增', () => {
    for (let i = 1; i < STAGE_LEVELS.length; i += 1) {
      expect(STAGE_LEVELS[i].min).toBeGreaterThan(STAGE_LEVELS[i - 1].min);
    }
  });

  it('每日上限已提速', () => {
    expect(FACET_DAILY_CAPS.affection).toBe(8);
    expect(FACET_DAILY_CAPS.intimacy).toBe(6);
  });
});
