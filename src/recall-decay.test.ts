import { describe, expect, it } from 'vitest';
import { DECAY_FLOOR, recallDecay } from './memory-domain';

const NOW = Date.parse('2026-10-31T12:00:00+08:00');
const dayAgo = (days: number) =>
  new Date(NOW - days * 86_400_000).toISOString().slice(0, 10);

describe('recallDecay（遗忘曲线：降权，不删除）', () => {
  it('核心分区永不衰减：人物底色 / 称呼关系 / 雷区禁忌 / 他的更正', () => {
    for (const section of ['人物底色', '称呼与关系', '他的雷区', '他的更正（最高优先级）']) {
      expect(recallDecay({ source: 'fact', section, date: dayAgo(3650) }, NOW)).toBe(1);
    }
  });

  it('今天的条目几乎不衰减', () => {
    const d = recallDecay({ source: 'event', section: '共同经历', date: dayAgo(0) }, NOW);
    expect(d).toBeGreaterThan(0.99);
  });

  it('事件半衰期 90 天：90 天后剩一半', () => {
    const d = recallDecay({ source: 'event', section: '共同经历', date: dayAgo(90) }, NOW);
    expect(d).toBeCloseTo(0.5, 2);
  });

  it('事实半衰期 180 天：比事件淡得慢', () => {
    const fact = recallDecay({ source: 'fact', section: '他的偏好', date: dayAgo(90) }, NOW);
    const event = recallDecay({ source: 'event', section: '共同经历', date: dayAgo(90) }, NOW);
    expect(fact).toBeGreaterThan(event);
    expect(fact).toBeCloseTo(Math.pow(0.5, 0.5), 2);
  });

  it('有下限：再老也不会彻底沉底', () => {
    const d = recallDecay({ source: 'event', section: '共同经历', date: dayAgo(5000) }, NOW);
    expect(d).toBe(DECAY_FLOOR);
  });

  it('没有日期 / 日期非法 → 不衰减（信息不足时保守处理）', () => {
    expect(recallDecay({ source: 'fact', section: '关于他', date: null }, NOW)).toBe(1);
    expect(recallDecay({ source: 'fact', section: '关于他', date: '不是日期' }, NOW)).toBe(1);
  });

  it('未来日期不放大（不会因为时钟漂移变成加成）', () => {
    const future = new Date(NOW + 10 * 86_400_000).toISOString().slice(0, 10);
    expect(recallDecay({ source: 'event', section: '共同经历', date: future }, NOW)).toBe(1);
  });
});
