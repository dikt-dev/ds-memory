import { describe, expect, it } from 'vitest';
import { recallTier } from './memory-engine';

describe('recallTier —— 分段保底', () => {
  it('预算充足走完整链路', () => {
    expect(recallTier(0)).toBe('full');
    expect(recallTier(299)).toBe('full');
  });

  it('过了软阈值只在最近 7 天里排', () => {
    expect(recallTier(300)).toBe('recent');
    expect(recallTier(1499)).toBe('recent');
  });

  it('过了硬阈值只给核心层——超时不再等于空召回', () => {
    expect(recallTier(1500)).toBe('summary');
    expect(recallTier(5000)).toBe('summary');
  });

  it('阈值可注入，方便单测与调参', () => {
    expect(recallTier(50, 100, 200)).toBe('full');
    expect(recallTier(150, 100, 200)).toBe('recent');
    expect(recallTier(250, 100, 200)).toBe('summary');
  });
});
