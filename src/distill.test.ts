import { afterEach, describe, expect, it, vi } from 'vitest';
import { distillDay, distillText } from './distill';
import type { Env } from './types';

const env = {
  DEEPSEEK_API_KEY: 'test-key',
  DEEPSEEK_MODEL: 'deepseek-v4-flash',
  DISTILL_DEEPSEEK_MODEL: 'deepseek-v4-pro',
} as unknown as Env;

function mockFetch() {
  const calls: any[] = [];
  const fn = vi.fn(async (_url: string, init: any) => {
    calls.push(JSON.parse(init.body));
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '- [26-10-30] 一条事实' }, finish_reason: 'stop' }],
        usage: { prompt_cache_hit_tokens: 10, prompt_cache_miss_tokens: 20, completion_tokens: 30 },
      }),
    };
  });
  vi.stubGlobal('fetch', fn);
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe('每日归档使用 v4-pro + 思考模式', () => {
  it('distillDay 打开思考并放宽 max_tokens', async () => {
    const calls = mockFetch();
    const r = await distillDay(env, '2026-10-30', '用户：你好', '# 记忆');
    expect(r.backend).toBe('deepseek');
    expect(calls[0].model).toBe('deepseek-v4-pro');
    expect(calls[0].thinking).toEqual({ type: 'enabled' });
    expect(calls[0].max_tokens).toBe(8192);
  });

  it('其他提炼（摘要等）仍然关闭思考以控成本', async () => {
    const calls = mockFetch();
    await distillText(env, 'sys', 'user', 120);
    expect(calls[0].thinking).toEqual({ type: 'disabled' });
  });

  it('空内容时报出 finish_reason，便于判断是不是被 length 截断', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '' }, finish_reason: 'length' }] }),
    })));
    const withAi = { ...env, AI: { run: async () => ({ response: '兜底文本' }) } } as unknown as Env;
    const r = await distillDay(withAi, '2026-10-30', 'x', 'y');
    // 思维链把额度吃光时不能静默返回空：必须回退 Workers AI，且结果可用
    expect(r.backend).toBe('workers-ai');
    expect(r.text).toBe('兜底文本');
  });
});