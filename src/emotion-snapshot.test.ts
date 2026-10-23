import { describe, expect, it } from 'vitest';
import { buildEmotionSnapshot, describeEmotionState, emotionDirectorText } from './emotion-snapshot';
import { emptyEmotionVector } from './emotion-vector';
import { FACET_DEFAULTS, type RelationFacets } from './relation-facets';
import type { EmotionEvent } from './emotion-events';

const NOW = Date.UTC(2026, 9, 23, 12, 0, 0);
const facets: RelationFacets = { ...FACET_DEFAULTS };
const base: RelationFacets = facets;

function insultEvent(at = NOW - 60_000, evidence = '你懂什么'): EmotionEvent {
  return { type: 'insult', intensity: 3, target: 'ai', evidence, at, resolved: false };
}

describe('buildEmotionSnapshot', () => {
  it('常态只输出关系 + 这一轮（省 token）', () => {
    const text = buildEmotionSnapshot({ facets, vector: emptyEmotionVector(), events: [], now: NOW });
    expect(text).toContain('## 我现在的状态');
    expect(text).toContain('- 关系：');
    expect(text).toContain('- 这一轮：');
    expect(text.split('\n')).toHaveLength(3);
  });

  it('有情绪时带上程度词和原因，但不暴露数字', () => {
    const vector = { ...emptyEmotionVector(), grievance: 35 };
    const text = buildEmotionSnapshot({ facets, vector, events: [insultEvent()], now: NOW });
    expect(text).toContain('有点委屈');
    expect(text).toContain('因为「你懂什么」');
    expect(text).not.toMatch(/\d{2,}/); // 提示词里不再出现数值
  });

  it('未化解的负向事件会写进「心里还记着」', () => {
    const text = buildEmotionSnapshot({ facets, vector: emptyEmotionVector(), events: [insultEvent()], now: NOW });
    expect(text).toContain('心里还记着');
    expect(text).toContain('还没过去');
  });

  it('已化解的事件不再提', () => {
    const resolved = { ...insultEvent(), resolved: true };
    const text = buildEmotionSnapshot({ facets, vector: emptyEmotionVector(), events: [resolved], now: NOW });
    expect(text).not.toContain('心里还记着');
  });

  it('超龄（>7 天）的芥蒂不再提', () => {
    const old = insultEvent(NOW - 8 * 86400_000);
    const text = buildEmotionSnapshot({ facets, vector: emptyEmotionVector(), events: [old], now: NOW });
    expect(text).not.toContain('心里还记着');
  });

  it('被冷落会多一句小情绪', () => {
    const text = buildEmotionSnapshot({
      facets,
      vector: emptyEmotionVector(),
      events: [],
      now: NOW,
      wasIgnored: true,
    });
    expect(text).toContain('小情绪');
  });

  it('闹别扭时这一轮会要求「别一句话翻篇」', () => {
    const vector = { ...emptyEmotionVector(), grievance: 60 };
    const text = buildEmotionSnapshot({ facets, vector, events: [], now: NOW });
    expect(text).toContain('别急着说');
  });

  it('对方倒苦水时，这一轮改为「接住情绪」', () => {
    const pain: EmotionEvent = {
      type: 'share_pain',
      intensity: 2,
      target: 'user',
      evidence: '压力好大',
      at: NOW - 60_000,
      resolved: true,
    };
    const text = buildEmotionSnapshot({
      facets,
      vector: emptyEmotionVector(),
      events: [pain],
      now: NOW,
    });
    expect(text).toContain('先接住情绪');
    expect(text).not.toContain('熟悉而自然');
  });

  it('整段不超过 6 行', () => {
    const vector = { ...emptyEmotionVector(), grievance: 60, shyness: 40, fatigue: 50, valence: 50 };
    const text = buildEmotionSnapshot({
      facets: { ...facets, attraction: 700, intimacy: 700, affection: 700, trust: 700, respect: 700 },
      vector,
      events: [insultEvent()],
      now: NOW,
      wasIgnored: true,
    });
    expect(text.split('\n').length).toBeLessThanOrEqual(6);
  });
});

describe('emotionDirectorText', () => {
  it('委屈高 → 不许立刻原谅', () => {
    const tips = emotionDirectorText({ ...emptyEmotionVector(), grievance: 50 });
    expect(tips.join('')).toContain('别急着说');
  });

  it('最多两条指令', () => {
    const tips = emotionDirectorText({
      ...emptyEmotionVector(),
      grievance: 60,
      shyness: 40,
      attachment: 50,
      fatigue: 50,
      valence: 50,
    });
    expect(tips).toHaveLength(2);
  });

  it('平静时无额外指令', () => {
    expect(emotionDirectorText(emptyEmotionVector())).toHaveLength(0);
  });
});

describe('describeEmotionState（调试）', () => {
  it('返回原型与主导情绪', () => {
    const s = describeEmotionState({
      facets: { ...base, intimacy: 700 },
      vector: { ...emptyEmotionVector(), grievance: 50 },
      events: [insultEvent()],
      now: NOW,
    });
    expect(s.archetype).toContain('闹别扭');
    expect(s.dominant[0].label).toBe('委屈');
    expect(s.unresolved[0].type).toBe('insult');
  });
});
