import { describe, expect, it } from 'vitest';
import { buildAttitudePolicy, explainAttitude } from './attitude-policy';
import { emptyEmotionVector } from './emotion-vector';
import { FACET_DEFAULTS, type RelationFacets } from './relation-facets';
import type { EmotionEvent } from './emotion-events';

const NOW = Date.UTC(2026, 9, 24, 12, 0, 0);
const base: RelationFacets = { ...FACET_DEFAULTS };

function insult(): EmotionEvent {
  return { type: 'insult', intensity: 3, target: 'ai', evidence: '你懂什么', at: NOW - 60_000, resolved: false };
}
function pain(): EmotionEvent {
  return { type: 'share_pain', intensity: 2, target: 'user', evidence: '压力好大', at: NOW - 60_000, resolved: true };
}

function policy(overrides: Partial<Parameters<typeof buildAttitudePolicy>[0]> = {}) {
  return buildAttitudePolicy({
    facets: base,
    vector: emptyEmotionVector(),
    events: [],
    now: NOW,
    ...overrides,
  });
}

describe('buildAttitudePolicy', () => {
  it('输出关系/这一轮，且不暴露数字', () => {
    const p = policy();
    expect(p.text).toContain('## 关系与态度');
    expect(p.text).toContain('- 关系：');
    expect(p.text).toContain('- 这一轮：');
    expect(p.text).not.toMatch(/\d/);
    expect(p.policy_version).toBe('attitude-v1');
  });

  it('被贬低时不要立刻翻篇', () => {
    const p = policy({ vector: { ...emptyEmotionVector(), grievance: 60 }, events: [insult()] });
    expect(p.text).toContain('别一句话就翻篇');
    expect(p.directives.length).toBeGreaterThan(0);
  });

  it('对方倒苦水时优先接住情绪', () => {
    const p = policy({ events: [pain()] });
    expect(p.text).toContain('先接住情绪');
    expect(p.text).not.toContain('熟悉而自然');
  });

  it('被冷落时允许一点小情绪，但不审问', () => {
    const p = policy({ wasIgnored: true });
    expect(p.text).toContain('小情绪');
    expect(p.text).toContain('别真的生气');
  });

  it('解释结构包含 archetype/原因，但不把数值放进 text', () => {
    const e = explainAttitude({
      facets: { ...base, intimacy: 700, affection: 700, trust: 700 },
      vector: { ...emptyEmotionVector(), grievance: 40 },
      events: [insult()],
      now: NOW,
    });
    expect(e.archetype).toBeTruthy();
    expect(e.dominant.length).toBeGreaterThan(0);
    expect(e.unresolved[0].type).toBe('insult');
    expect(e.text).not.toMatch(/\d/);
  });

  it('安全边界：不宣称真实意识/不施压/不威胁遗弃', () => {
    const text = policy({ wasIgnored: true, vector: { ...emptyEmotionVector(), grievance: 80 } }).text;
    for (const bad of ['真实意识', '我会消失', '求你别走', '你只能是我的', '我恨你']) {
      expect(text).not.toContain(bad);
    }
  });
});
