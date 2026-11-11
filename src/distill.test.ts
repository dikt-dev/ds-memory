import { afterEach, describe, expect, it, vi } from 'vitest';
import { distillDay, distillText } from './distill';
import type { Env } from './types';

const env = {
  DEEPSEEK_API_KEY: 'test-key',
  DEEPSEEK_MODEL: 'deepseek-v4-flash',
  DISTILL_DEEPSEEK_MODEL: 'deepseek-v4-pro',
} as unknown as Env;

describe('兜底换官方供应商，不用 Workers AI（2026-11-11）', () => {
  it('两家官方都挂 → backend=none，不产出可写记忆的文本', async () => {
    const dead = {
      DEEPSEEK_API_KEY: '',
      DASHSCOPE_API_KEY: '',
      AI: { run: async () => { throw new Error('should not be called'); } },
    } as unknown as Env;
    const r = await distillText(dead, 'system', 'user', 64);
    expect(r.backend).toBe('none');
    expect(r.text).toBe('');
  });

  it('主家失败会换另一家官方供应商再试一次', async () => {
    const seen: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      seen.push(String(url));
      if (seen.length === 1) return { ok: false, status: 500, body: { cancel: async () => {} } };
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: '- [26-11-11] 一条事实' } }] }),
      };
    }));
    const both = { DEEPSEEK_API_KEY: 'k1', DASHSCOPE_API_KEY: 'k2', DEEPSEEK_MODEL: 'deepseek-flash' } as unknown as Env;
    const r = await distillText(both, 'sys', 'user', 64);
    expect(r.text).toContain('一条事实');
    expect(seen.length).toBe(2);
    expect(seen[0]).not.toBe(seen[1]);
  });
});

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

  it('主家空内容（被 length 截断）→ 换备家；备家也空则不写记忆', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '' }, finish_reason: 'length' }] }),
    })));
    const r = await distillDay(env, '2026-10-30', 'x', 'y');
    expect(r.backend).toBe('none');
    expect(r.text).toBe('');
  });
});