/**
 * SSE 帧重写（纯函数 + 可单测）。
 *
 * 为什么要单独一层：流式响应是「原样透传」的，用户看到的就是模型吐出的原文。
 * 之前只在流结束、落库前清洗，结果是**库里干净、用户看到的是「您」「很高兴为您服务」**。
 * 这里把 SSE 行拆开、只替换 choices[0].delta.content，其余字段/事件原样保留。
 *
 * 设计约束：
 * - 非 data 行（注释、空行、心跳）一律原样返回，保持 SSE 分帧不被破坏
 * - 只碰 content 字段，role/usage/finish_reason 等不动
 * - [DONE] 之前必须先把清洗器扣住的尾巴补出去，否则最后十几个字会丢
 */

import { createStreamScrubber, type StreamScrubber } from './anti-ai-flavor';

export interface SseUsage {
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  completion_tokens?: number;
}

export interface SseRewriter {
  /** 处理一行（不含换行符），返回应当写回客户端的行列表 */
  rewrite(line: string): string[];
  /** 流结束时的收尾行（补尾巴） */
  flush(): string[];
  /** 已清洗的完整文本（用于落库/计费） */
  text(): string;
  /** 最近一次解析到的 usage */
  usage(): SseUsage | null;
}

function dataFrame(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n`;
}

export function createSseRewriter(scrubber: StreamScrubber = createStreamScrubber()): SseRewriter {
  let accumulated = '';
  let usage: SseUsage | null = null;
  let finished = false;

  return {
    rewrite(line: string): string[] {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) return [line];
      const payload = trimmed.slice(5).trim();
      if (!payload) return [line];

      if (payload === '[DONE]') {
        finished = true;
        const tail = scrubber.flush();
        if (!tail) return [line];
        accumulated += tail;
        // 尾巴单独成一帧，且要用空行与 [DONE] 隔开；否则两条 data 行会被
        // 客户端当成同一个事件的 payload，JSON 解析直接失败。
        return [dataFrame({ choices: [{ delta: { content: tail } }] }).trimEnd(), '', line];
      }

      try {
        const parsed = JSON.parse(payload) as {
          choices?: { delta?: { content?: unknown } }[];
          usage?: SseUsage;
        };
        if (parsed.usage) usage = parsed.usage;
        const delta = parsed.choices?.[0]?.delta?.content;
        if (typeof delta !== 'string') return [line];
        const cleaned = scrubber.push(delta);
        accumulated += cleaned;
        const choice = parsed.choices?.[0];
        if (choice?.delta) choice.delta.content = cleaned;
        return [dataFrame(parsed).trimEnd()];
      } catch {
        // 无法解析的行原样放行（保持上游格式，不吞内容）
        return [line];
      }
    },

    flush(): string[] {
      if (finished) return [];
      finished = true;
      const tail = scrubber.flush();
      if (!tail) return [];
      accumulated += tail;
      return [dataFrame({ choices: [{ delta: { content: tail } }] }).trimEnd(), ''];
    },

    text: () => accumulated,
    usage: () => usage,
  };
}
