/**
 * 模型调用的唯一出口。
 *
 * 以前每个文件各自写死 https://api.deepseek.com/chat/completions，想换供应商要改好几处，
 * 而且不同家的参数还不一样（DeepSeek 用 thinking:{type}，千问用 enable_thinking）。
 *
 * 现在按任务独立配置，互不影响：
 *   LLM_PROVIDER / LLM_MODEL                       全局默认
 *   LLM_<KIND>_PROVIDER / _BASE_URL / _API_KEY / _MODEL
 *     KIND = CHAT | DISTILL | SUMMARY | DIARY
 *   LLM_FALLBACK_PROVIDER / _MODEL / _API_KEY      主供应商挂了自动切
 *
 * 什么都不配时退回原来的行为（官方 DeepSeek），一行环境变量都不用加。
 */

export type LlmVendor = 'deepseek' | 'dashscope';
export type LlmKind = 'chat' | 'distill' | 'summary' | 'diary' | 'judge';

export interface LlmTarget {
  vendor: LlmVendor;
  url: string;
  apiKey: string;
  model: string;
  /** 兜底链路里的第二家，日志里要区分 */
  fallback?: boolean;
}

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
const DASHSCOPE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';

interface LlmEnv {
  LLM_PROVIDER?: string;
  LLM_BASE_URL?: string;
  LLM_API_KEY?: string;
  LLM_MODEL?: string;
  LLM_CHAT_PROVIDER?: string;
  LLM_CHAT_BASE_URL?: string;
  LLM_CHAT_API_KEY?: string;
  LLM_CHAT_MODEL?: string;
  LLM_DISTILL_PROVIDER?: string;
  LLM_DISTILL_BASE_URL?: string;
  LLM_DISTILL_API_KEY?: string;
  LLM_DISTILL_MODEL?: string;
  LLM_SUMMARY_PROVIDER?: string;
  LLM_SUMMARY_BASE_URL?: string;
  LLM_SUMMARY_API_KEY?: string;
  LLM_SUMMARY_MODEL?: string;
  LLM_DIARY_PROVIDER?: string;
  LLM_DIARY_BASE_URL?: string;
  LLM_DIARY_API_KEY?: string;
  LLM_DIARY_MODEL?: string;
  LLM_JUDGE_PROVIDER?: string;
  LLM_JUDGE_BASE_URL?: string;
  LLM_JUDGE_API_KEY?: string;
  LLM_JUDGE_MODEL?: string;
  LLM_FALLBACK_PROVIDER?: string;
  LLM_FALLBACK_BASE_URL?: string;
  LLM_FALLBACK_API_KEY?: string;
  LLM_FALLBACK_MODEL?: string;
  DEEPSEEK_API_KEY?: string;
  DASHSCOPE_API_KEY?: string;
  DEEPSEEK_MODEL: string;
  DISTILL_DEEPSEEK_MODEL?: string;
  SUMMARY_DEEPSEEK_MODEL?: string;
}

const KIND_KEY: Record<LlmKind, string> = {
  chat: 'CHAT',
  distill: 'DISTILL',
  summary: 'SUMMARY',
  diary: 'DIARY',
  judge: 'JUDGE',
};

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/** 按 kind 取环境变量，取不到再退全局。 */
function pick(env: LlmEnv, kind: LlmKind, suffix: 'PROVIDER' | 'BASE_URL' | 'API_KEY' | 'MODEL'): string | undefined {
  const perKind = (env as unknown as Record<string, unknown>)[`LLM_${KIND_KEY[kind]}_${suffix}`];
  return str(perKind) ?? str((env as unknown as Record<string, unknown>)[`LLM_${suffix}`]);
}

/** 各任务在没显式指定模型时用的默认；和以前的 DEEPSEEK_*_MODEL 保持一致。 */
function defaultModel(env: LlmEnv, kind: LlmKind): string {
  switch (kind) {
    case 'distill':
      return str(env.LLM_DISTILL_MODEL) || env.DISTILL_DEEPSEEK_MODEL || env.DEEPSEEK_MODEL;
    case 'summary':
      return str(env.LLM_SUMMARY_MODEL) || env.SUMMARY_DEEPSEEK_MODEL || env.DEEPSEEK_MODEL;
    case 'judge':
      // 情绪判定是「判断题」：要读懂反讽、问句、转述，模型太小会一律答 none
      return str(env.LLM_JUDGE_MODEL) || str(env.LLM_DISTILL_MODEL) || env.DEEPSEEK_MODEL;
    default:
      return env.DEEPSEEK_MODEL;
  }
}

function toVendor(v?: string): LlmVendor {
  return v?.trim().toLowerCase() === 'dashscope' ? 'dashscope' : 'deepseek';
}

function keyFor(vendor: LlmVendor, env: LlmEnv): string {
  return (vendor === 'dashscope' ? str(env.DASHSCOPE_API_KEY) : str(env.DEEPSEEK_API_KEY)) || '';
}

/** 解析出这次调用该打到哪个地址、用哪个 key、哪个模型。 */
export function resolveLlm(env: LlmEnv, kind: LlmKind = 'chat', model?: string): LlmTarget {
  const vendor = toVendor(pick(env, kind, 'PROVIDER'));
  const url = pick(env, kind, 'BASE_URL') ?? (vendor === 'dashscope' ? DASHSCOPE_URL : DEEPSEEK_URL);
  const apiKey = pick(env, kind, 'API_KEY') ?? keyFor(vendor, env);
  return {
    vendor,
    url,
    apiKey,
    model: str(model) || pick(env, kind, 'MODEL') || defaultModel(env, kind),
  };
}

/**
 * 兜底目标：只配了 LLM_FALLBACK_PROVIDER 才启用。
 * 和主目标撞成同一个地址+模型时返回 null，免得白重试一次。
 */
export function fallbackLlm(env: LlmEnv, kind: LlmKind): LlmTarget | null {
  const primary = resolveLlm(env, kind);
  // ★ 默认走「另一家」而不是写死某一家（2026-11-07 官方 DeepSeek 抖动）：
  //   写死 deepseek 时，主用官方的那几条（对话/日记）根本没有兜底——
  //   官方一抖就直接失败，只能干等它恢复。
  const explicitVendor = str(env.LLM_FALLBACK_PROVIDER);
  const vendor: LlmVendor = explicitVendor ? toVendor(explicitVendor) : primary.vendor === 'dashscope' ? 'deepseek' : 'dashscope';
  const url = str(env.LLM_FALLBACK_BASE_URL) ?? (vendor === 'dashscope' ? DASHSCOPE_URL : DEEPSEEK_URL);
  const apiKey = str(env.LLM_FALLBACK_API_KEY) ?? keyFor(vendor, env);
  // 没显式配模型时：千问侧用同名的 deepseek-v4.1-flash-1017，官方侧用 deepseek-flash
  const model =
    str(env.LLM_FALLBACK_MODEL) ??
    (vendor === 'dashscope' ? 'deepseek-v4.1-flash-1017' : 'deepseek-flash');
  if (!apiKey || !model) return null;
  if (primary.url === url && primary.model === model) return null;
  return { vendor, url, apiKey, model, fallback: true };
}

/** 主 + 备，按顺序尝试。 */
export function llmTargets(env: LlmEnv, kind: LlmKind, model?: string): LlmTarget[] {
  const primary = resolveLlm(env, kind, model);
  const fb = fallbackLlm(env, kind);
  return fb ? [primary, fb] : [primary];
}

/** 这些状态码说明这家暂时不可用，值得用兜底再试一次。 */
export function shouldFallbackStatus(status: number): boolean {
  return status === 401 || status === 403 || status === 408 || status === 429 || status >= 500;
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
