import { describe, expect, it } from 'vitest';
import { resolveLlm, fallbackLlm, llmTargets, buildBody, thinkingParams, shouldFallbackStatus } from './llm';
import { normalizeMemoryDates } from './distill';

const base = { DEEPSEEK_MODEL: 'deepseek-flash', DEEPSEEK_API_KEY: 'dk', DASHSCOPE_API_KEY: 'qk' };
const QWEN = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
const DEEP = 'https://api.deepseek.com/chat/completions';

describe('llm 统一入口', () => {
  it('什么都不配时还是官方 DeepSeek，行为不变', () => {
    const t = resolveLlm(base, 'chat');
    expect(t.vendor).toBe('deepseek');
    expect(t.url).toBe(DEEP);
    expect(t.apiKey).toBe('dk');
    expect(t.model).toBe('deepseek-flash');
  });

  it('全局切千问后地址和 key 一起换', () => {
    const t = resolveLlm({ ...base, LLM_PROVIDER: 'dashscope', LLM_MODEL: 'deepseek-v4.1-flash-1017' }, 'chat');
    expect(t.vendor).toBe('dashscope');
    expect(t.url).toBe(QWEN);
    expect(t.apiKey).toBe('qk');
    expect(t.model).toBe('deepseek-v4.1-flash-1017');
  });

  it('按任务覆盖：日记走千问，对话仍留官方', () => {
    const env = { ...base, LLM_DIARY_PROVIDER: 'dashscope', LLM_DIARY_MODEL: 'qwen3.7-plus' };
    expect(resolveLlm(env, 'diary')).toMatchObject({ vendor: 'dashscope', model: 'qwen3.7-plus' });
    expect(resolveLlm(env, 'chat')).toMatchObject({ vendor: 'deepseek', model: 'deepseek-flash' });
  });

  it('全切千问 + 官方兜底时有两段链路', () => {
    const env = {
      ...base,
      LLM_PROVIDER: 'dashscope',
      LLM_MODEL: 'deepseek-v4.1-flash-1017',
      LLM_FALLBACK_PROVIDER: 'deepseek',
      LLM_FALLBACK_MODEL: 'deepseek-flash',
    };
    const [primary, fallback] = llmTargets(env, 'chat');
    expect(primary).toMatchObject({ vendor: 'dashscope', model: 'deepseek-v4.1-flash-1017' });
    expect(fallback).toMatchObject({ vendor: 'deepseek', model: 'deepseek-flash', fallback: true });
    expect(fallback.apiKey).toBe('dk');
  });

  it('没配兜底就只有一段；撞成同一家时也不重复', () => {
    expect(llmTargets(base, 'chat')).toHaveLength(1);
    const same = { ...base, LLM_PROVIDER: 'deepseek', LLM_FALLBACK_PROVIDER: 'deepseek' };
    expect(fallbackLlm(same, 'chat')).toBeNull();
  });

  it('只有该重试的状态码才切兜底', () => {
    expect(shouldFallbackStatus(500)).toBe(true);
    expect(shouldFallbackStatus(429)).toBe(true);
    expect(shouldFallbackStatus(401)).toBe(true);
    expect(shouldFallbackStatus(400)).toBe(false);
    expect(shouldFallbackStatus(200)).toBe(false);
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
