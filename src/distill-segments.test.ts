import { describe, expect, it } from 'vitest';
import {
  DISTILL_MAX_SEGMENTS,
  DISTILL_MIN_CONVERSATION_CHARS,
  DISTILL_PROMPT_BUDGET_CHARS,
  DISTILL_SEGMENT_CHARS,
  distillSegmentChars,
  splitDistillSegments,
} from './distill';
import { buildDistillConversation } from './distill-view';

describe('splitDistillSegments', () => {
  it('短对话只有一段，原样返回', () => {
    const conv = '用户：你好\n\n助手：在呢';
    expect(splitDistillSegments(conv, 1000)).toEqual([conv]);
  });

  it('超长按消息边界切段，不切断单条消息', () => {
    const msg = 'x'.repeat(40);
    const conv = Array.from({ length: 10 }, (_, i) => `用户：${i}${msg}`).join('\n\n');
    const segs = splitDistillSegments(conv, 100);
    expect(segs.length).toBeGreaterThan(1);
    for (const seg of segs) {
      for (const part of seg.split('\n\n')) {
        expect(part.length).toBeLessThanOrEqual(msg.length + 6);
      }
    }
    // 拼回去顺序不丢
    expect(segs.join('\n\n').replace(/\s+/g, '')).toBe(conv.replace(/\s+/g, ''));
  });

  it('单条超长消息自成一段，不被切碎', () => {
    const huge = 'y'.repeat(500);
    const segs = splitDistillSegments(`用户：${huge}\n\n助手：好`, 100);
    expect(segs[0]).toBe(`用户：${huge}`);
  });

  it('段数有上限，防止病态输入打爆调用次数', () => {
    const conv = Array.from({ length: 2000 }, (_, i) => `用户：${i}${'z'.repeat(200)}`).join('\n\n');
    expect(splitDistillSegments(conv, 100).length).toBeLessThanOrEqual(DISTILL_MAX_SEGMENTS);
  });
});

describe('distillSegmentChars', () => {
  it('记忆小的时候用满 60K', () => {
    expect(distillSegmentChars(10_000)).toBe(DISTILL_SEGMENT_CHARS);
  });

  it('记忆涨了自动收窄对话预算，别超上下文', () => {
    const memory = 80_000;
    const chars = distillSegmentChars(memory);
    expect(chars).toBe(DISTILL_PROMPT_BUDGET_CHARS - memory);
    expect(chars + memory).toBeLessThanOrEqual(DISTILL_PROMPT_BUDGET_CHARS);
  });

  it('记忆再大也给对话留底线', () => {
    expect(distillSegmentChars(500_000)).toBe(DISTILL_MIN_CONVERSATION_CHARS);
  });
});

describe('buildDistillConversation 长度', () => {
  it('她的长回复不再被砍到 400 字', () => {
    const reply = '她'.repeat(1500);
    const out = buildDistillConversation([{ role: 'assistant', content: reply }]);
    expect(out).toContain('她'.repeat(1500));
  });

  it('用户长叙述保留到 12000 字', () => {
    const text = '我'.repeat(9000);
    const out = buildDistillConversation([{ role: 'user', content: text }]);
    expect(out).toContain('我'.repeat(9000));
  });

  it('超长仍会截断并注明', () => {
    const text = '长'.repeat(20000);
    const out = buildDistillConversation([{ role: 'user', content: text }]);
    expect(out).toContain('后略');
  });
});
