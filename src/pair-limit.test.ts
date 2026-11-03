import { describe, expect, it } from 'vitest';
import { pairRateLimit } from './routes-app';

/** 极简 KV：只实现 get/put，够用来验限流窗口。 */
function fakeEnv() {
  const store = new Map<string, string>();
  return {
    store,
    env: {
      KV: {
        get: async (k: string) => store.get(k) ?? null,
        put: async (k: string, v: string) => {
          store.set(k, v);
        },
      },
    } as never,
  };
}

describe('配对码限流', () => {
  const NOW = Date.parse('2026-11-03T10:00:00+08:00');

  it('前 8 次放行，第 9 次拦住', async () => {
    const { env } = fakeEnv();
    for (let i = 0; i < 8; i++) {
      const r = await pairRateLimit(env, '1.1.1.1', NOW);
      expect(r.blocked).toBe(false);
    }
    const blocked = await pairRateLimit(env, '1.1.1.1', NOW);
    expect(blocked.blocked).toBe(true);
    expect(blocked.retryAfter).toBeGreaterThan(0);
  });

  it('不同 IP 各算各的', async () => {
    const { env } = fakeEnv();
    for (let i = 0; i < 9; i++) await pairRateLimit(env, '2.2.2.2', NOW);
    expect((await pairRateLimit(env, '3.3.3.3', NOW)).blocked).toBe(false);
  });

  it('过了窗口重新开始计数', async () => {
    const { env } = fakeEnv();
    for (let i = 0; i < 9; i++) await pairRateLimit(env, '4.4.4.4', NOW);
    expect((await pairRateLimit(env, '4.4.4.4', NOW)).blocked).toBe(true);
    expect((await pairRateLimit(env, '4.4.4.4', NOW + 11 * 60 * 1000)).blocked).toBe(false);
  });
});
