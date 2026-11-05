/**
 * DeepSeek 调用核心（网页聊天与 OpenAI 兼容端点共用）：
 * 流式透传（OpenAI 格式 SSE）+ 用量采集 + 落库/计费回调；非流式完成。
 */
import type { Env } from './types';
import { llmTargets, shouldFallbackStatus, thinkingParams, type LlmKind } from './llm';
import { calcCost, loadPricing, type TokenUsage } from './pricing';
import { scrubAiFlavor } from './anti-ai-flavor';
import { createSseRewriter } from './sse-scrub';
import { logError, logWarn } from './error-log';

export type MessageContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface DeepSeekMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | MessageContentPart[];
}

export const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';

/**
 * 去掉落单的 UTF-16 代理字符。
 * 典型来源：emoji 被截断、旧消息/提示词里只剩 `\ud83d`。
 * JSON.stringify 会把它写成非法的 `\ud83d`，DeepSeek 直接 400。
 */
function stripLoneSurrogates(text: string): string {
  return text
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '')
    .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
}

export function sanitizeDeepSeekMessages(messages: DeepSeekMessage[]): DeepSeekMessage[] {
  return messages.map((m) => {
    if (typeof m.content === 'string') {
      return { ...m, content: stripLoneSurrogates(m.content) };
    }
    return {
      ...m,
      content: m.content.map((part) =>
        part.type === 'text' ? { ...part, text: stripLoneSurrogates(part.text) } : part,
      ),
    };
  });
}

/** DeepSeek 400 常见于历史过长/请求过大；保留 system + 最近交互再试一次。 */
function compactDeepSeekMessages(messages: DeepSeekMessage[]): DeepSeekMessage[] {
  const system = messages.filter((m) => m.role === 'system');
  const rest = messages.filter((m) => m.role !== 'system');
  return [...system, ...rest.slice(-14)];
}

/** 首字节超时：模型卡住时，30 秒内连响应头都不给就直接放弃。 */
const DEEPSEEK_FIRST_BYTE_MS = 30_000;
/** 总时长上限：正常回复几秒到几十秒，3 分钟还没结束基本是挂住了。 */
const DEEPSEEK_TOTAL_MS = 180_000;

/**
 * 调 DeepSeek 的唯一出口。
 *
 * 以前裸 fetch：模型侧卡住时没有任何打断手段，请求一直吊着，
 * 白烧 Worker 时长，前端也只看到「正在输入…」永远不动。
 */
/** 聊天温度：env 可覆盖，夹在 0.3~1.2，防止手滑填个 2 */
function chatTemperature(env: Env): number {
  const raw = Number((env as { CHAT_TEMPERATURE?: string }).CHAT_TEMPERATURE ?? '');
  if (!Number.isFinite(raw) || raw <= 0) return 0.8;
  return Math.min(1.2, Math.max(0.3, raw));
}

async function requestDeepSeek(
  env: Env,
  apiKey: string,
  messages: DeepSeekMessage[],
  stream: boolean,
  maxTokens?: number,
  opts: { thinking?: boolean; timing?: Record<string, number> } = {},
  kind: LlmKind = 'chat',
): Promise<Response> {
  // 主供应商挂了（超时/5xx/429）自动切兜底，聊天不至于整个断掉
  const targets = llmTargets(env, kind);
  let lastError: unknown = null;

  for (let i = 0; i < targets.length; i += 1) {
    const target = targets[i];
    const controller = new AbortController();
    const firstByteTimer = setTimeout(
      () => controller.abort(new Error('llm timeout: no response in 30s')),
      DEEPSEEK_FIRST_BYTE_MS,
    );
    const totalTimer = setTimeout(
      () => controller.abort(new Error('llm timeout: over 180s')),
      DEEPSEEK_TOTAL_MS,
    );
    const clearAll = () => {
      clearTimeout(firstByteTimer);
      clearTimeout(totalTimer);
    };

    let res: Response;
    const tFetch = Date.now();
    try {
      res = await fetch(target.url, {
        signal: controller.signal,
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${target.apiKey || apiKey}` },
        body: JSON.stringify({
          model: target.model,
          messages: sanitizeDeepSeekMessages(messages),
          ...(stream
            ? { stream: true, stream_options: { include_usage: true } }
            : { max_tokens: maxTokens ?? 4096 }),
          // 聊天温度默认 0.8（想要更野就调 CHAT_TEMPERATURE）；
          // 两个 penalty 是治"平"的主力：她之前每轮都用"才看见……"开头，
          // 靠加大 presence 才压得住那种口头禅循环。
          temperature: chatTemperature(env),
          frequency_penalty: 0.3,
          presence_penalty: 0.35,
          // 聊天必须快：思考模式只在日记/记忆这类后台任务里开
          ...thinkingParams(target.vendor, opts.thinking),
        }),
      });
    } catch (e) {
      clearAll();
      lastError = e;
      if (i < targets.length - 1) continue;
      throw e;
    }

    if (opts.timing) opts.timing.upstreamMs = Date.now() - tFetch;
    if (!res.ok && i < targets.length - 1 && shouldFallbackStatus(res.status)) {
      clearAll();
      lastError = new Error(`${target.vendor} HTTP ${res.status}`);
      await res.body?.cancel().catch(() => {});
      continue;
    }

  // 响应头到了就撤掉首字节计时；总时长计时留到流读完，避免长回复被误杀
  clearTimeout(firstByteTimer);
  if (!res.body) {
    clearTimeout(totalTimer);
    return res;
  }
  const wrapped = res.body.pipeThrough(
    new TransformStream({
      transform(chunk, ctrl) {
        ctrl.enqueue(chunk);
      },
      flush() {
        clearTimeout(totalTimer);
      },
      cancel() {
        clearTimeout(totalTimer);
      },
    }),
  );
    return new Response(wrapped, { status: res.status, headers: res.headers });
  }

  throw lastError ?? new Error('llm: 没有可用的供应商');
}

export function normalizeUsage(
  u?: { prompt_cache_hit_tokens?: number; prompt_cache_miss_tokens?: number; completion_tokens?: number },
): TokenUsage {
  return {
    prompt_cache_hit_tokens: u?.prompt_cache_hit_tokens ?? 0,
    prompt_cache_miss_tokens: u?.prompt_cache_miss_tokens ?? 0,
    completion_tokens: u?.completion_tokens ?? 0,
  };
}

const encoder = new TextEncoder();

/** 流式结束回调的返回值：可以只给费用，也可以带上刚落库的消息 id（前端用来推进轮询游标）。 */
export type FinishResult = number | { cost: number; ids?: { user?: number; assistant?: number } };

/**
 * 流式调用 DeepSeek，透传 SSE（增量内容先过 AI 味清洗再推给客户端）。
 * onFinish：流结束后回调（落库/计费），返回费用或 {cost, ids}。
 * appendUsageEvent：网页端为 true，会在流末尾追加 usage 事件。
 */
export async function streamDeepSeek(
  env: Env,
  messages: DeepSeekMessage[],
  opts: {
    appendUsageEvent: boolean;
    /** 回复预算（max_tokens）；不传则用上游默认 */
    maxTokens?: number;
    onFinish: (text: string, usage: TokenUsage | null) => Promise<FinishResult>;
    /** 分段耗时埋点：传入对象会被填上 upstreamMs（发请求 → 收到响应头） */
    timing?: Record<string, number>;
  },
): Promise<Response> {
  const apiKey = env.DEEPSEEK_API_KEY ?? '';
  if (!apiKey) {
    return Response.json({ error: { message: 'DEEPSEEK_API_KEY 未配置', type: 'server_error' } }, { status: 500 });
  }

  let upstream: Response;
  try {
    upstream = await requestDeepSeek(env, apiKey, messages, true, opts.maxTokens, { timing: opts.timing });
    if (upstream.status === 400) {
      const detail = await upstream.clone().text().catch(() => '');
      logError('[deepseek] upstream 400, retry compact:', detail.slice(0, 300));
      upstream = await requestDeepSeek(
        env,
        apiKey,
        compactDeepSeekMessages(messages),
        true,
        opts.maxTokens,
      );
    }
  } catch (e) {
    logError('[deepseek] fetch failed:', e);
    return Response.json({ error: { message: 'DeepSeek 请求失败，请稍后重试', type: 'server_error' } }, { status: 502 });
  }
  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => '');
    logError('[deepseek] upstream error:', upstream.status, detail);
    return Response.json(
      {
        error: {
          message: `DeepSeek 返回错误（${upstream.status}）`,
          type: 'server_error',
          detail: detail.slice(0, 300),
        },
      },
      { status: 502 },
    );
  }
  if (!upstream.body) {
    return Response.json({ error: { message: 'DeepSeek 返回空流', type: 'server_error' } }, { status: 502 });
  }

  let carry = '';
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  // ★ 流式清洗：用户看到的这一层也要干净（以前只清洗了落库文本）
  const rewriter = createSseRewriter();

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      carry += decoder.decode(chunk, { stream: true });
      const lines = carry.split('\n');
      carry = lines.pop() ?? ''; // 最后一段可能是不完整的行，留到下一块
      for (const line of lines) {
        for (const out of rewriter.rewrite(line)) controller.enqueue(encoder.encode(`${out}\n`));
      }
    },
    async flush(controller) {
      if (carry) {
        for (const out of rewriter.rewrite(carry)) controller.enqueue(encoder.encode(`${out}\n`));
      }
      // 流没有 [DONE] 就结束了：把扣住的尾巴补出去，用户才能看到结尾
      for (const out of rewriter.flush()) controller.enqueue(encoder.encode(`${out}\n`));
      let cost = 0;
      let ids: { user?: number; assistant?: number } | undefined;
      const usage = rewriter.usage() ? normalizeUsage(rewriter.usage()!) : null;
      try {
        // ★ 落库前再洗一次（幂等）：保证库里和用户看到的是同一份文本
        const cleaned = scrubAiFlavor(rewriter.text());
        const r = await opts.onFinish(cleaned.text, usage);
        if (typeof r === 'number') {
          cost = r;
        } else {
          cost = r.cost;
          ids = r.ids;
        }
      } catch (e) {
        logError('[deepseek] onFinish failed:', e);
      }
      if (opts.appendUsageEvent) {
        // 带上刚落库的消息 id：前端靠它推进轮询游标，否则 3 秒后的增量拉取会把
        // 刚发出的消息当成“新消息”再渲染一遍（网页上就出现了重复）
        const payload = { event: 'usage', cost_rmb: cost, usage, ...(ids ? { ids } : {}) };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      }
    },
  });

  return new Response(upstream.body.pipeThrough(transform), {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      'x-accel-buffering': 'no',
    },
  });
}

export interface DeepSeekCompletion {
  text: string;
  usage: TokenUsage | null;
  cost: number;
  id: string;
  created: number;
  finishReason: string;
}

export type DeepSeekCompletionResult = DeepSeekCompletion | { error: string; status: number };

/** 非流式调用 DeepSeek。 */
export async function completeDeepSeek(
  env: Env,
  messages: DeepSeekMessage[],
  now: Date,
  maxTokens = 4096,
  opts: { thinking?: boolean; kind?: LlmKind } = {},
): Promise<DeepSeekCompletionResult> {
  const apiKey = env.DEEPSEEK_API_KEY ?? '';
  const kind = opts.kind ?? 'chat';
  if (!apiKey && !env.DASHSCOPE_API_KEY) {
    return { error: '没有配置模型 key（DEEPSEEK_API_KEY / DASHSCOPE_API_KEY）', status: 500 };
  }
  let res: Response;
  try {
    res = await requestDeepSeek(env, apiKey, messages, false, maxTokens, opts, kind);
    if (res.status === 400) {
      const detail = await res.clone().text().catch(() => '');
      logError('[deepseek] upstream 400, retry compact:', detail.slice(0, 300));
      res = await requestDeepSeek(
        env,
        apiKey,
        compactDeepSeekMessages(messages),
        false,
        maxTokens,
        opts,
        kind,
      );
    }
  } catch (e) {
    logError('[deepseek] fetch failed:', e);
    return { error: 'DeepSeek 请求失败，请稍后重试', status: 502 };
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    logError('[deepseek] upstream error:', res.status, detail);
    return {
      error: `DeepSeek 返回错误（${res.status}）${detail ? `：${detail.slice(0, 160)}` : ''}`,
      status: 502,
    };
  }
  const data = (await res.json()) as {
    id?: string;
    created?: number;
    choices?: { message?: { content?: unknown }; finish_reason?: string }[];
    usage?: { prompt_cache_hit_tokens?: number; prompt_cache_miss_tokens?: number; completion_tokens?: number };
  };
  const text = typeof data.choices?.[0]?.message?.content === 'string' ? data.choices[0].message.content : '';
  const usage = data.usage ? normalizeUsage(data.usage) : null;
  // ★ 非流式输出也清洗 AI 味（主动消息、摘要、提炼等）
  const cleaned = scrubAiFlavor(text);
  return {
    text: cleaned.text,
    usage,
    cost: usage ? calcCost(usage, loadPricing(env), now) : 0,
    id: data.id ?? `chatcmpl-${crypto.randomUUID()}`,
    created: data.created ?? Math.floor(now.getTime() / 1000),
    finishReason: data.choices?.[0]?.finish_reason ?? 'stop',
  };
}
