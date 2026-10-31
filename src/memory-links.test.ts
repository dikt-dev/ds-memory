import { describe, expect, it } from 'vitest';
import { expansionBudget } from './memory-links';

describe('expansionBudget', () => {
  it('挑够了就不扩：1→3 的膨胀必须止住', () => {
    expect(expansionBudget(2)).toBe(0);
    expect(expansionBudget(3)).toBe(0);
    expect(expansionBudget(5)).toBe(0);
  });

  it('只挑中 1 条时补，最多补到 3 条', () => {
    expect(expansionBudget(1)).toBe(2);
  });

  it('一条都没挑中就不扩——没有根，扩出来的也没有依据', () => {
    expect(expansionBudget(0)).toBe(0);
  });
});
