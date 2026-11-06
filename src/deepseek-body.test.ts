import { afterEach, describe, expect, it, vi } from 'vitest';
import { streamDeepSeek } from './deepseek';

afterEach(() => vi.unstubAllGlobals());

function stubFetch(calls: Array<{ url: string; body: Record<string, unknown> }>) {
  vi.stubGlobal('fetch', async (url: string, init: { body?: string }) => {
    calls.push({ url, body: JSON.parse(init.body ?? '{}') });
    return new Response('data: {"choices":[{"delta":{"content":"好"}}]}\n\ndata: [DONE]\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  });
}

describe('DeepSeek 请求体', () => {
  it('流式请求也带 max_tokens（2026-11-06 修）', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    stubFetch(calls);
    const env = { DEEPSEEK_API_KEY: 'k', DEEPSEEK_MODEL: 'deepseek-flash' } as never;
    await streamDeepSeek(env, [{ role: 'user', content: '在吗' }], {
      appendUsageEvent: false,
      maxTokens: 8192,
      onFinish: async () => 0,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].body.stream).toBe(true);
    expect(calls[0].body.max_tokens).toBe(8192);
    expect(calls[0].body.stream_options).toEqual({ include_usage: true });
  });

  it('不传 maxTokens 时给默认 4096，不会漏成 undefined', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    stubFetch(calls);
    const env = { DEEPSEEK_API_KEY: 'k', DEEPSEEK_MODEL: 'deepseek-flash' } as never;
    await streamDeepSeek(env, [{ role: 'user', content: '在吗' }], {
      appendUsageEvent: false,
      onFinish: async () => 0,
    });
    expect(calls[0].body.max_tokens).toBe(4096);
  });
});
