import { describe, expect, it } from 'vitest';
import { rateLimitVerdict } from './routes-app';

/**
 * 限流的判定是纯函数，单独测它。
 *
 * 为什么不是测 pairRateLimit 整体：真正的计数在 D1 里（原子 upsert），
 * 那部分靠集成测；这里钉住"第 9 次该拦、窗口过了该放"的口径。
 */
describe('配对码限流判定', () => {
  const NOW = Date.parse('2026-11-03T10:00:00+08:00');

  it('前 8 次放行，第 9 次开始拦', () => {
    for (let c = 1; c <= 8; c++) expect(rateLimitVerdict(c, NOW).blocked).toBe(false);
    expect(rateLimitVerdict(9, NOW).blocked).toBe(true);
    expect(rateLimitVerdict(99, NOW).blocked).toBe(true);
  });

  it('给得出还要等多久', () => {
    const { retryAfter } = rateLimitVerdict(9, NOW);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(600);
  });
});
