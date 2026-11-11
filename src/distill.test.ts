import { afterEach, describe, expect, it, vi } from 'vitest';
import { distillDay, distillText, looksLikeMemoryLines } from './distill';
import type { Env } from './types';

const env = {
  DEEPSEEK_API_KEY: 'test-key',
  DEEPSEEK_MODEL: 'deepseek-v4-flash',
  DISTILL_DEEPSEEK_MODEL: 'deepseek-v4-pro',
} as unknown as Env;

describe('兜底模型只写「像记忆」的内容（2026-11-11）', () => {
  it('记忆条目格式通过，散文/空内容不过', () => {
    expect(looksLikeMemoryLines('- [26-11-11] 他去修了 bug')).toBe(true);
    expect(looksLikeMemoryLines('今天聊了很多','x' as never)).toBe(false);
    expect(looksLikeMemoryLines('')).toBe(false);
  });

  it('主办方与 Workers AI 都挂 → backend=none，不产出可写记忆的文本', async () => {
    const dead = {
      DEEPSEEK_API_KEY: '',
      DASHSCOPE_API_KEY: '',
      AI: { run: async () => { throw new Error('all models down'); } },
    } as unknown as Env;
    const r = await distillText(dead, 'system', 'user', 64);
    expect(r.backend).toBe('none');
    expect(r.text).toBe('');
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

  it('空内容时回退 Workers AI；兜底是记忆条目才采用', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '' }, finish_reason: 'length' }] }),
    })));
    const good = { ...env, AI: { run: async () => ({ response: '- [26-10-30] 他去修了 bug' }) } } as unknown as Env;
    const r = await distillDay(good, '2026-10-30', 'x', 'y');
    expect(r.backend).toBe('workers-ai');
    expect(r.text).toContain('修了 bug');
  });

  it('兜底返回散文（不是记忆条目）→ 不写记忆，标成待补', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '' }, finish_reason: 'length' }] }),
    })));
    const bad = { ...env, AI: { run: async () => ({ response: '兜底文本' }) } } as unknown as Env;
    const r = await distillDay(bad, '2026-10-30', 'x', 'y');
    expect(r.backend).toBe('none');
    expect(r.text).toBe('');
  });
});