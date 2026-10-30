import { describe, expect, it } from 'vitest';
import { extractEmotionEvents, reconcileWithApology } from './emotion-events';

const T0 = 1_700_000_000_000;
const pick = (text: string, type: string) => extractEmotionEvents(text, T0).find((e) => e.type === type);

describe('情感事件抽取调优', () => {
  it('玩笑语境里的骂人词退成 tease，不记委屈', () => {
    const events = extractEmotionEvents('你个蠢货哈哈哈', T0);
    expect(events.some((e) => e.type === 'insult')).toBe(false);
    expect(events.some((e) => e.type === 'tease')).toBe(true);
  });

  it('没有玩笑标记时仍然是 insult', () => {
    expect(pick('你个蠢货', 'insult')?.intensity).toBeGreaterThanOrEqual(1);
  });

  it('「有点累」比「累死了」轻', () => {
    const weak = pick('有点累', 'share_pain')?.intensity ?? 0;
    const strong = pick('累死了', 'share_pain')?.intensity ?? 0;
    expect(strong).toBeGreaterThan(weak);
  });

  it('五小时前的道歉仍然能化解', () => {
    const at = T0 - 5 * 3600_000;
    const events = [
      { type: 'insult' as const, intensity: 3 as const, target: 'ai' as const, evidence: 'x', at: at - 60_000, resolved: false },
      { type: 'apology' as const, intensity: 2 as const, target: 'ai' as const, evidence: '对不起', at, resolved: true },
    ];
    expect(reconcileWithApology(events, T0)[0].resolved).toBe(true);
  });

  it('七小时前的道歉过期，旧账还在', () => {
    const at = T0 - 7 * 3600_000;
    const events = [
      { type: 'insult' as const, intensity: 3 as const, target: 'ai' as const, evidence: 'x', at: at - 60_000, resolved: false },
      { type: 'apology' as const, intensity: 2 as const, target: 'ai' as const, evidence: '对不起', at, resolved: true },
    ];
    expect(reconcileWithApology(events, T0)[0].resolved).toBe(false);
  });
});