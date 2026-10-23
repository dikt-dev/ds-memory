import { describe, expect, it } from 'vitest';
import {
  applyEventsToVector,
  extractEmotionEvents,
  needsAiEventReview,
  parseAiEventLabels,
  reconcileWithApology,
  sumFacetDelta,
  unresolvedEvents,
  type EmotionEvent,
} from './emotion-events';
import { emptyEmotionVector } from './emotion-vector';

const AT = Date.UTC(2026, 9, 23, 12, 0, 0);

describe('extractEmotionEvents —— 词典抽取', () => {
  it('夸人 → praise', () => {
    const events = extractEmotionEvents('你好厉害啊', AT);
    expect(events[0].type).toBe('praise');
    expect(events[0].target).toBe('ai');
  });

  it('骂人 → insult，强度最高', () => {
    const events = extractEmotionEvents('你懂什么，废物', AT);
    expect(events[0].type).toBe('insult');
    expect(events[0].intensity).toBe(3);
  });

  it('道歉 → apology', () => {
    expect(extractEmotionEvents('对不起，是我不好', AT)[0].type).toBe('apology');
  });

  it('否定词过滤：「不难过了」不记 share_pain', () => {
    const events = extractEmotionEvents('我不难过了', AT);
    expect(events.some((e) => e.type === 'share_pain')).toBe(false);
  });

  it('一条消息最多 3 个事件', () => {
    const events = extractEmotionEvents('谢谢你，你真厉害，我好开心哈哈哈', AT);
    expect(events.length).toBeLessThanOrEqual(3);
  });

  it('空文本返回空', () => {
    expect(extractEmotionEvents('   ', AT)).toEqual([]);
  });

  it('感叹号会提升强度', () => {
    const events = extractEmotionEvents('你懂什么！！', AT);
    expect(events[0].intensity).toBe(3);
  });

  it('反讽不当作夸奖：「呵呵，真厉害」→ 轻量 insult', () => {
    const events = extractEmotionEvents('呵呵，真厉害', AT);
    expect(events.some((e) => e.type === 'praise')).toBe(false);
    expect(events[0].type).toBe('insult');
    expect(events[0].intensity).toBe(1);
  });

  it('口语变体也能识别：「压力好大」「好累」「有点累」', () => {
    expect(extractEmotionEvents('最近压力好大', AT)[0].type).toBe('share_pain');
    expect(extractEmotionEvents('今天好累', AT)[0].type).toBe('share_pain');
    expect(extractEmotionEvents('今天有点累，被老板说了', AT)[0].type).toBe('share_pain');
  });

  it('不能把「积累/累计」误判成累', () => {
    expect(extractEmotionEvents('这几年积累了不少经验', AT)).toHaveLength(0);
  });
});

describe('applyEventsToVector —— 事件改变情绪', () => {
  it('被骂 → 委屈上升', () => {
    const events = extractEmotionEvents('你懂什么', AT);
    const v = applyEventsToVector(emptyEmotionVector(), events);
    expect(v.grievance).toBeGreaterThan(0);
    expect(v.valence).toBeLessThan(0);
  });

  it('道歉 → 委屈大幅下降', () => {
    const start = { ...emptyEmotionVector(), grievance: 60 };
    const events = extractEmotionEvents('对不起，我错了', AT);
    const v = applyEventsToVector(start, events);
    expect(v.grievance).toBeLessThan(40);
  });

  it('被夸 → 害羞 + 轻快', () => {
    const v = applyEventsToVector(emptyEmotionVector(), extractEmotionEvents('你好厉害', AT));
    expect(v.shyness).toBeGreaterThan(0);
    expect(v.valence).toBeGreaterThan(0);
  });
});

describe('reconcileWithApology —— 和解', () => {
  it('道歉把更早的负向事件标记为已化解', () => {
    const insult: EmotionEvent = {
      type: 'insult',
      intensity: 3,
      target: 'ai',
      evidence: '你懂什么',
      at: AT - 60_000,
      resolved: false,
    };
    const apology: EmotionEvent = {
      type: 'apology',
      intensity: 2,
      target: 'ai',
      evidence: '对不起',
      at: AT,
      resolved: true,
    };
    const merged = reconcileWithApology([insult, apology], AT);
    expect(merged[0].resolved).toBe(true);
  });

  it('道歉之前的账才消，之后的还要重新哄', () => {
    const later: EmotionEvent = {
      type: 'insult',
      intensity: 3,
      target: 'ai',
      evidence: '说你呢',
      at: AT + 1,
      resolved: false,
    };
    const apology: EmotionEvent = {
      type: 'apology',
      intensity: 2,
      target: 'ai',
      evidence: '对不起',
      at: AT,
      resolved: true,
    };
    const merged = reconcileWithApology([later, apology], AT);
    expect(merged[0].resolved).toBe(false);
  });
});

describe('unresolvedEvents', () => {
  it('只返回未化解、强度够、没超龄的负向事件', () => {
    const events: EmotionEvent[] = [
      { type: 'insult', intensity: 3, target: 'ai', evidence: 'a', at: AT, resolved: false },
      { type: 'insult', intensity: 1, target: 'ai', evidence: 'b', at: AT, resolved: false },
      { type: 'insult', intensity: 3, target: 'ai', evidence: 'c', at: AT, resolved: true },
      { type: 'praise', intensity: 3, target: 'ai', evidence: 'd', at: AT, resolved: true },
      { type: 'insult', intensity: 3, target: 'ai', evidence: 'e', at: AT - 30 * 86400_000, resolved: false },
    ];
    const out = unresolvedEvents(events, AT);
    expect(out).toHaveLength(1);
    expect(out[0].evidence).toBe('a');
  });
});

describe('sumFacetDelta —— 5 轴增量', () => {
  it('被骂同时掉喜欢和尊重', () => {
    const d = sumFacetDelta(extractEmotionEvents('你懂什么，废物', AT));
    expect(d.affection).toBeLessThan(0);
    expect(d.respect).toBeLessThan(0);
  });

  it('道歉加信任', () => {
    const d = sumFacetDelta(extractEmotionEvents('对不起', AT));
    expect(d.trust).toBeGreaterThan(0);
  });

  it('表白加心动', () => {
    const d = sumFacetDelta(extractEmotionEvents('想你了', AT));
    expect(d.attraction).toBeGreaterThan(0);
  });
});

describe('needsAiEventReview', () => {
  it('反讽必定复核', () => {
    expect(needsAiEventReview('呵呵，真厉害', [])).toBe(true);
  });

  it('正负冲突要复核', () => {
    const events = extractEmotionEvents('谢谢你，但你真没用', AT);
    expect(needsAiEventReview('谢谢你，但你真没用', events)).toBe(true);
  });

  it('纯粹的夸不复核（省额度）', () => {
    const text = '你好厉害';
    expect(needsAiEventReview(text, extractEmotionEvents(text, AT))).toBe(false);
  });
});

describe('parseAiEventLabels', () => {
  it('解析类型:强度', () => {
    const events = parseAiEventLabels('praise:2,tease:1', AT);
    expect(events.map((e) => e.type)).toEqual(['praise', 'tease']);
    expect(events[0].intensity).toBe(2);
  });

  it('none / 无 → 空', () => {
    expect(parseAiEventLabels('none', AT)).toEqual([]);
    expect(parseAiEventLabels('无', AT)).toEqual([]);
  });

  it('容错未知标签', () => {
    expect(parseAiEventLabels('whatever:3', AT)).toEqual([]);
  });
});
