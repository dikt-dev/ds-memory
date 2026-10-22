import { describe, expect, it } from 'vitest';
import {
  MAX_DAILY_LOSS,
  applyGradualChange,
  applyInactivityDecay,
  estimateDaysToReach,
  maxGainAt,
} from './relation-growth';

describe('maxGainAt —— 边际递减', () => {
  it('低分段增长快', () => {
    expect(maxGainAt(0)).toBe(5);
    expect(maxGainAt(199)).toBe(5);
  });

  it('高分段增长慢', () => {
    expect(maxGainAt(200)).toBe(3);
    expect(maxGainAt(400)).toBe(2);
    expect(maxGainAt(600)).toBe(1);
    expect(maxGainAt(800)).toBe(1);
    expect(maxGainAt(999)).toBe(1);
  });

  it('单调递减', () => {
    let prev = Infinity;
    for (let v = 0; v < 1000; v += 50) {
      const g = maxGainAt(v);
      expect(g).toBeLessThanOrEqual(prev);
      prev = g;
    }
  });
});

describe('applyGradualChange —— 上升受限', () => {
  it('低分段可以涨满 5 分', () => {
    const r = applyGradualChange(100, 200);
    expect(r.applied).toBe(5);
    expect(r.next).toBe(105);
    expect(r.capped).toBe(true);
  });

  it('高分段每天只涨 1', () => {
    const r = applyGradualChange(900, 1000);
    expect(r.applied).toBe(1);
    expect(r.next).toBe(901);
  });

  it('小幅提议时按实际值涨', () => {
    const r = applyGradualChange(100, 102);
    expect(r.applied).toBe(2);
    expect(r.capped).toBe(false);
  });

  it('连续互动 7 天以上有小幅加成', () => {
    const normal = applyGradualChange(400, 500);
    const withStreak = applyGradualChange(400, 500, { streakDays: 10 });
    expect(withStreak.applied).toBeGreaterThan(normal.applied);
  });

  it('长期没互动时增长打折', () => {
    const normal = applyGradualChange(400, 500);
    const rusty = applyGradualChange(400, 500, { daysSinceInteraction: 10 });
    expect(rusty.applied).toBeLessThan(normal.applied);
  });
});

describe('applyGradualChange —— 下降不受递减约束', () => {
  it('高分段也能掉 5 分', () => {
    const r = applyGradualChange(900, 800);
    expect(r.applied).toBe(-MAX_DAILY_LOSS);
    expect(r.next).toBe(895);
  });

  it('下降幅度超过上限时被截断', () => {
    const r = applyGradualChange(500, 400);
    expect(r.applied).toBe(-5);
    expect(r.capped).toBe(true);
  });

  it('边界钳制', () => {
    expect(applyGradualChange(3, 0).next).toBe(0);
  });
});

describe('applyInactivityDecay —— 长期不联系衰减', () => {
  it('7 天内不衰减', () => {
    expect(applyInactivityDecay(500, 7).applied).toBe(0);
    expect(applyInactivityDecay(500, 3).applied).toBe(0);
  });

  it('超过 7 天后缓慢下降', () => {
    const r = applyInactivityDecay(500, 10);
    expect(r.applied).toBeLessThan(0);
    expect(r.next).toBeLessThan(500);
  });

  it('衰减有上限（单次最多 15）', () => {
    const r = applyInactivityDecay(500, 100);
    expect(r.applied).toBeGreaterThanOrEqual(-15);
  });

  it('不会掉到负数', () => {
    expect(applyInactivityDecay(5, 100).next).toBe(0);
  });
});

describe('estimateDaysToReach —— 日积月累的量化', () => {
  it('从 0 到 500 需要很长时间', () => {
    const days = estimateDaysToReach(0, 500);
    // 0-200 段每天 5 分（40天），200-400 每天 3 分（67天），400-500 每天 2 分（50天）
    expect(days).toBeGreaterThan(140);
    expect(days).toBeLessThan(200);
  });

  it('从 900 到 1000 需要 100 天', () => {
    const days = estimateDaysToReach(900, 1000);
    expect(days).toBe(100); // 每天 1 分
  });

  it('已经达到时返回 0', () => {
    expect(estimateDaysToReach(500, 400)).toBe(0);
    expect(estimateDaysToReach(500, 500)).toBe(0);
  });

  it('一年能从 0 涨到多少', () => {
    // 模拟 365 天
    let cur = 0;
    for (let i = 0; i < 365; i++) cur = Math.min(1000, cur + maxGainAt(cur));
    expect(cur).toBeGreaterThan(600); // 一年能到"亲近"档
    expect(cur).toBeLessThan(1000);   // 但涨不满
  });
});
