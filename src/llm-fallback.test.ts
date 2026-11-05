import { afterEach, describe, expect, it, vi } from 'vitest';
import { completeDeepSeek } from './deepseek';
import type { Env } from './types';

/**
 * 兜底链路的端到端验证：主供应商 500 → 自动换官方再试一次。
 * 这条路径平时不会触发，靠这个测试证明它接对了。
 */
const env = {
  DEEPSEEK_MODEL: 'deepseek-flash',
  DEEPSEEK_API_KEY: 'dk',
  DASHSCOPE_API_KEY: 'qk',
  LLM_PROVIDER: 'dashscope',
  LLM_MODEL: 'deepseek-v4.1-flash-1017',
  LLM_FALLBACK_PROVIDER: 'deepseek',
  LLM_FALLBACK_MODEL: 'deepseek-flash',
} as unknown as Env;

const okBody = JSON.stringify({
  choices: [{ message: { content: '好' }, finish_reason: 'stop' }],
  usage: { prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 1, completion_tokens: 1 },
});

afterEach(() => vi.unstubAllGlobals());

describe('模型兜底', () => {
  it('主供应商 500 时自动切官方', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(String(url));
      if (calls.length === 1) return new Response('{"error":"boom"}', { status: 500 });
      return new Response(okBody, { status: 200, headers: { 'content-type': 'application/json' } });
    });

    const res = await completeDeepSeek(env, [{ role: 'user', content: 'hi' }], new Date(), 64);

    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain('dashscope.aliyuncs.com');
    expect(calls[1]).toContain('api.deepseek.com');
    expect('error' in res).toBe(false);
    if (!('error' in res)) expect(res.text).toBe('好');
  });

  it('400 属于请求本身有问题，不换家重试', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(String(url));
      return new Response('{"error":"bad"}', { status: 400 });
    });

    const res = await completeDeepSeek(env, [{ role: 'user', content: 'hi' }], new Date(), 64);

    expect('error' in res).toBe(true);
    // 400 会走一次 compact 重试（同一家），但不会切到官方
    expect(calls.every((u) => u.includes('dashscope.aliyuncs.com'))).toBe(true);
  });
});
