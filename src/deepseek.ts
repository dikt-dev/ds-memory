/**
 * DeepSeek 调用核心（网页聊天与 OpenAI 兼容端点共用）：
 * 流式透传（OpenAI 格式 SSE）+ 用量采集 + 落库/计费回调；非流式完成。
 */
import type { Env } from './types';
import { calcCost, loadPricing, type TokenUsage } from './pricing';
import { scrubAiFlavor } from './anti-ai-flavor';
import { createSseRewriter } from './sse-scrub';

export type MessageContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface DeepSeekMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | MessageContentPart[];
}

export const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';

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
  },
): Promise<Response> {
  const apiKey = env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return Response.json({ error: { message: 'DEEPSEEK_API_KEY 未配置', type: 'server_error' } }, { status: 500 });
  }

  let upstream: Response;
  try {
    upstream = await fetch(DEEPSEEK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: env.DEEPSEEK_MODEL,
        messages,
        stream: true,
        stream_options: { include_usage: true },
        ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
        // 活人感：稍高的温度 + 轻微重复惩罚，避免每轮用同一套句式
        temperature: 1.2,
        frequency_penalty: 0.3,
        presence_penalty: 0.2,
        // deepseek-flash/v4-pro 默认开启思考模式（effort=high），这里关闭：回复更快、成本可预期
        thinking: { type: 'disabled' },
      }),
    });
  } catch (e) {
    console.error('[deepseek] fetch failed:', e);
    return Response.json({ error: { message: 'DeepSeek 请求失败，请稍后重试', type: 'server_error' } }, { status: 502 });
  }
  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => '');
    console.error('[deepseek] upstream error:', upstream.status, detail);
    return Response.json({ error: { message: `DeepSeek 返回错误（${upstream.status}）`, type: 'server_error' } }, { status: 502 });
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
        console.error('[deepseek] onFinish failed:', e);
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
): Promise<DeepSeekCompletionResult> {
  const apiKey = env.DEEPSEEK_API_KEY;
  if (!apiKey) return { error: 'DEEPSEEK_API_KEY 未配置', status: 500 };
  let res: Response;
  try {
    res = await fetch(DEEPSEEK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: env.DEEPSEEK_MODEL,
        messages,
        max_tokens: maxTokens,
        temperature: 1.2,
        frequency_penalty: 0.3,
        presence_penalty: 0.2,
        // 关闭思考模式（默认开启 effort=high，会额外消耗按输出计费的 reasoning tokens）
        thinking: { type: 'disabled' },
      }),
    });
  } catch (e) {
    console.error('[deepseek] fetch failed:', e);
    return { error: 'DeepSeek 请求失败，请稍后重试', status: 502 };
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    console.error('[deepseek] upstream error:', res.status, detail);
    return { error: `DeepSeek 返回错误（${res.status}）`, status: 502 };
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
