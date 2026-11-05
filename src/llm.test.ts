import { describe, expect, it } from 'vitest';
import { resolveLlm, buildBody, thinkingParams } from './llm';
import { normalizeMemoryDates } from './distill';

const base = { DEEPSEEK_MODEL: 'deepseek-flash', DEEPSEEK_API_KEY: 'dk', DASHSCOPE_API_KEY: 'qk' };

describe('llm 统一入口', () => {
  it('默认还是官方 DeepSeek，行为不变', () => {
    const t = resolveLlm(base, 'chat');
    expect(t.vendor).toBe('deepseek');
    expect(t.url).toBe('https://api.deepseek.com/chat/completions');
    expect(t.apiKey).toBe('dk');
    expect(t.model).toBe('deepseek-flash');
  });

  it('切成 dashscope 后地址和 key 一起换', () => {
    const t = resolveLlm({ ...base, LLM_PROVIDER: 'dashscope', LLM_MODEL: 'deepseek-v4.1-flash-1017' }, 'chat');
    expect(t.vendor).toBe('dashscope');
    expect(t.url).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions');
    expect(t.apiKey).toBe('qk');
    expect(t.model).toBe('deepseek-v4.1-flash-1017');
  });

  it('思考开关按家翻译', () => {
    expect(thinkingParams('deepseek', false)).toEqual({ thinking: { type: 'disabled' } });
    expect(thinkingParams('dashscope', false)).toEqual({ enable_thinking: false });
    expect(thinkingParams('dashscope', true)).toEqual({ enable_thinking: true });
  });

  it('请求体不混用两家的字段', () => {
    const t = resolveLlm({ ...base, LLM_PROVIDER: 'dashscope' }, 'chat');
    const body = buildBody(t, [{ role: 'user', content: 'hi' }], { maxTokens: 32, thinking: false });
    expect(body).toHaveProperty('enable_thinking', false);
    expect(body).not.toHaveProperty('thinking');
    expect(body).toHaveProperty('max_tokens', 32);
  });
});

describe('记忆日期兜底', () => {
  const today = '2026-11-05';
  it('当月日相同但年份写错时纠正', () => {
    expect(normalizeMemoryDates('- [25-11-05] 作息=爱熬夜', today)).toBe('- [26-11-05] 作息=爱熬夜');
  });
  it('历史条目不动', () => {
    expect(normalizeMemoryDates('- [25-12-01] 一起去过展会', today)).toBe('- [25-12-01] 一起去过展会');
  });
  it('正确年份原样保留', () => {
    expect(normalizeMemoryDates('- [26-11-05] 他换工作了', today)).toBe('- [26-11-05] 他换工作了');
  });
});
