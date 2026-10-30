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

  it('「回滚方案」不算侮辱（真实误判案例）', () => {
    expect(extractEmotionEvents('# 记忆快照与回滚方案', T0).some((e) => e.type === 'insult')).toBe(false);
    expect(extractEmotionEvents('- 先做只读、可回滚、不改变线上回复的事', T0).some((e) => e.type === 'insult')).toBe(false);
    expect(extractEmotionEvents('回滚演练：在吗', T0)).toEqual([]);
  });

  it('真的说「滚」仍然是 insult', () => {
    expect(extractEmotionEvents('滚', T0).some((e) => e.type === 'insult')).toBe(true);
  });

  it('「马上给你点」不再算指令', () => {
    expect(extractEmotionEvents('好嘞，马上给你点', T0).some((e) => e.type === 'command')).toBe(false);
    expect(extractEmotionEvents('马上睡马上睡', T0).some((e) => e.type === 'command')).toBe(false);
  });

  it('「你马上过来」仍然是指令', () => {
    expect(extractEmotionEvents('你马上过来', T0).some((e) => e.type === 'command')).toBe(true);
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