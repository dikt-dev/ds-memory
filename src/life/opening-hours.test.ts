import { describe, expect, it } from 'vitest';
import { OPENING_HOURS, openAt } from './opening-hours';

describe('营业时间', () => {
  it('商场 10 点前不开门', () => {
    expect(openAt('outing_mall', 9 * 60)).toBe(false);
    expect(openAt('outing_mall', 10 * 60)).toBe(true);
  });

  it('打烊前 30 分钟就进不去了', () => {
    expect(openAt('outing_mall', 21 * 60 + 40)).toBe(false);
    expect(openAt('outing_mall', 21 * 60 + 20)).toBe(true);
  });

  it('没有门的活动不设限（散步、公园早市、家里的事）', () => {
    expect(openAt('outing_walk', 3 * 60)).toBe(true);
    expect(openAt('meal_normal', 3 * 60)).toBe(true);
  });

  it('菜市场是傍晚到夜里，书店早上 9 点才开', () => {
    expect(openAt('outing_market', 10 * 60)).toBe(false);
    expect(openAt('outing_market', 17 * 60)).toBe(true);
    expect(openAt('outing_bookstore', 8 * 60)).toBe(false);
    expect(openAt('outing_bookstore', 9 * 60)).toBe(true);
  });

  it('表里每一项都是合法区间', () => {
    for (const [id, [open, close]] of Object.entries(OPENING_HOURS)) {
      expect(open, id).toBeGreaterThanOrEqual(0);
      expect(close, id).toBeLessThanOrEqual(24 * 60);
      expect(open, id).toBeLessThan(close);
    }
  });
});
