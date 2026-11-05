import { describe, expect, it } from 'vitest';
import { peopleFor } from './state';

/**
 * 回归：公寓楼设定拆掉后 socialCastFor 恒为空数组。
 * 那时候 peopleFor 里写的是 cast[0]!.id —— 非空断言骗过编译器，
 * 线上直接 TypeError，ensureDayPlan 每天早上都炸，生活系统整整瘫了一段时间。
 */
describe('peopleFor', () => {
  it('社交阵容为空时返回 null，不抛异常', () => {
    expect(() => peopleFor([{ unitId: 'meal_friend' }], '2026-11-05')).not.toThrow();
    expect(peopleFor([{ unitId: 'meal_friend' }], '2026-11-05')).toBeNull();
  });

  it('没有社交活动时也是 null', () => {
    expect(peopleFor([{ unitId: 'work' }], '2026-11-05')).toBeNull();
  });
});
