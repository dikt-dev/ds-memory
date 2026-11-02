import { describe, expect, it } from 'vitest';
import { placeFor } from './place';

describe('房间地点', () => {
  it('做饭在厨房，看剧在客厅', () => {
    expect(placeFor('cook_meal', true)).toBe('厨房');
    expect(placeFor('anime_series', true)).toBe('客厅');
  });

  it('出门在外不写房间（活动本身是地点）', () => {
    expect(placeFor('cook_meal', false)).toBeNull();
    expect(placeFor('outing_cafe', true)).toBeNull();
  });

  it('没登记的活动返回 null，不硬编', () => {
    expect(placeFor('short_trip_hike', true)).toBeNull();
  });
});
