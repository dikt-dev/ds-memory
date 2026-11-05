/**
 * 模型调用的唯一出口。
 *
 * 以前每个文件各自写死 https://api.deepseek.com/chat/completions，想换供应商要改好几处，
 * 而且不同家的参数还不一样（DeepSeek 用 thinking:{type}，千问用 enable_thinking）。
 * 这里把「哪家、哪个模型、参数怎么拼」收在一处：
 *   LLM_PROVIDER=deepseek（默认）| dashscope
 *   各自可以再覆盖 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL
 * 没配就退回原来的行为，一行环境变量都不用加。
 */

export type LlmVendor = 'deepseek' | 'dashscope';
export type LlmKind = 'chat' | 'distill' | 'summary' | 'diary';

export interface LlmTarget {
  vendor: LlmVendor;
  url: string;
  apiKey: string;
  model: string;
}

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
const DASHSCOPE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';

interface LlmEnv {
  LLM_PROVIDER?: string;
  LLM_BASE_URL?: string;
  LLM_API_KEY?: string;
  LLM_MODEL?: string;
  LLM_DISTILL_MODEL?: string;
  LLM_SUMMARY_MODEL?: string;
  LLM_DIARY_MODEL?: string;
  DEEPSEEK_API_KEY?: string;
  DASHSCOPE_API_KEY?: string;
  DEEPSEEK_MODEL: string;
  DISTILL_DEEPSEEK_MODEL?: string;
  SUMMARY_DEEPSEEK_MODEL?: string;
}

/** 各任务在没显式指定模型时用的默认；和以前的 DEEPSEEK_*_MODEL 保持一致。 */
function defaultModel(env: LlmEnv, kind: LlmKind): string {
  switch (kind) {
    case 'distill':
      return env.LLM_DISTILL_MODEL || env.DISTILL_DEEPSEEK_MODEL || env.DEEPSEEK_MODEL;
    case 'summary':
      return env.LLM_SUMMARY_MODEL || env.SUMMARY_DEEPSEEK_MODEL || env.DEEPSEEK_MODEL;
    case 'diary':
      return env.LLM_DIARY_MODEL || env.DEEPSEEK_MODEL;
    default:
      return env.DEEPSEEK_MODEL;
  }
}

/** 解析出这次调用该打到哪个地址、用哪个 key、哪个模型。 */
export function resolveLlm(env: LlmEnv, kind: LlmKind = 'chat', model?: string): LlmTarget {
  const vendor: LlmVendor = env.LLM_PROVIDER?.trim().toLowerCase() === 'dashscope' ? 'dashscope' : 'deepseek';
  const url =
    env.LLM_BASE_URL?.trim() ||
    (vendor === 'dashscope' ? DASHSCOPE_URL : DEEPSEEK_URL);
  const apiKey =
    env.LLM_API_KEY?.trim() ||
    (vendor === 'dashscope' ? env.DASHSCOPE_API_KEY?.trim() : env.DEEPSEEK_API_KEY?.trim()) ||
    '';
  return {
    vendor,
    url,
    apiKey,
    model: model?.trim() || env.LLM_MODEL?.trim() || defaultModel(env, kind),
  };
}

/** 思考开关在各家的写法不一样，混用会直接 400。 */
export function thinkingParams(vendor: LlmVendor, thinking: boolean | undefined): Record<string, unknown> {
  const on = thinking === true;
  if (vendor === 'dashscope') {
    // 千问默认开思考，必须显式关；开着会让一句话拖到十几秒
    return { enable_thinking: on };
  }
  return { thinking: { type: on ? 'enabled' : 'disabled' } };
}

/** 拼请求体：两家都认 OpenAI 兼容字段，差异只在思考参数。 */
export function buildBody(
  target: LlmTarget,
  messages: unknown[],
  opts: { maxTokens?: number; thinking?: boolean; stream?: boolean; temperature?: number } = {},
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: target.model,
    messages,
    ...thinkingParams(target.vendor, opts.thinking),
  };
  if (opts.stream) {
    body.stream = true;
    body.stream_options = { include_usage: true };
  } else {
    body.max_tokens = opts.maxTokens ?? 4096;
  }
  if (opts.temperature !== undefined) body.temperature = opts.temperature;
  return body;
}
