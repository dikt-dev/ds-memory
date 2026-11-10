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

import { createStreamScrubber, stripLeadingStageDirection, type StreamScrubber } from './anti-ai-flavor';

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

/** 模型有时会把历史的说话人标记（「他：」「你：」）照抄在回复开头。 */
const SPEAKER_PREFIX_RE = /^\s*(?:他|你)：\s*/;

export interface SseRewriterOptions {
  /**
   * 密度高时把这一条的句首括号动作去掉（2026-11-10）。
   *
   * 只在「最近几条都是（动作）开头」时由调用方打开；因为 head 是扣住后才放行的，
   * 这里删掉的内容既不会推给客户端、也不会进 accumulated（=落库文本），两层一致。
   */
  trimLeadingAction?: boolean;
}

export function createSseRewriter(
  scrubber: StreamScrubber = createStreamScrubber(),
  options: SseRewriterOptions = {},
): SseRewriter {
  let accumulated = '';
  let usage: SseUsage | null = null;
  let finished = false;
  // 头几个字先扣住：够判断是不是「他：」「你：」再放行，否则用户会看到标记闪一下
  let prefixChecked = false;
  let held = '';

  const releasePrefix = (): string => {
    prefixChecked = true;
    let body = held.replace(SPEAKER_PREFIX_RE, '');
    // 开头是（动作）且密度高：整段去掉。stripLeadingStageDirection 在「只有动作没别的话」时会原样返回
    if (options.trimLeadingAction) body = stripLeadingStageDirection(body);
    held = '';
    return body;
  };

  /**
   * 还判断不了吗？
   *
   * 真实流里第一帧常常只是一个换行或半个词：只按长度判断会被「\n」提前放行，
   * 后面真正的「你：」就漏出去了。这里按"去掉空白后还剩几个字"判断：
   * 只剩 1 个字、或正好是「他」「你」，就继续等。
   */
  const needsMorePrefix = (): boolean => {
    // 要剥句首动作时，必须等到右括号出现才知道动作有多长（最多扣 40 字）
    if (options.trimLeadingAction) {
      const head = held.replace(/^\s+/, '');
      if (head.startsWith('（') || head.startsWith('(')) {
        const closeIdx = head.search(/[）)]/);
        // 还没闭合：继续等，等不到就按 40 字兜底
        if (closeIdx === -1) return head.length < 40;
        // 只有动作、后面还没有正文：再等一会儿，否则 stripLeadingStageDirection
        // 会因为「删完就空了」而原样返回（它为了保护空消息），动作就漏出去了
        if (!head.slice(closeIdx + 1).trim()) return head.length < 60;
      }
    }
    // 开头一律先扣住 8 个字符：真实流的第一帧可能只是换行/半个词，
    // 任何启发式判断都会漏。8 个字对用户体感无感，但足够看清「你：」。
    return held.length < 8;
  };

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
        let cleaned = '';
        if (prefixChecked) {
          cleaned = scrubber.push(delta);
        } else {
          held += delta;
          if (needsMorePrefix()) return [];
          cleaned = scrubber.push(releasePrefix());
        }
        if (!cleaned) return [];
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
      const head = prefixChecked ? '' : held ? scrubber.push(releasePrefix()) : '';
      const tail = scrubber.flush();
      const out = head + tail;
      if (!out) return [];
      accumulated += out;
      return [dataFrame({ choices: [{ delta: { content: out } }] }).trimEnd(), ''];
    },

    text: () => accumulated,
    usage: () => usage,
  };
}