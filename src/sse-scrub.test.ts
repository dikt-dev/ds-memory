import { describe, expect, it } from 'vitest';
import { createSseRewriter } from './sse-scrub';

const frame = (content: string) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}`;

const textOf = (lines: string[]): string =>
  lines
    .filter((l) => l.startsWith('data:'))
    .map((l) => {
      const payload = l.slice(5).trim();
      if (!payload || payload === '[DONE]') return '';
      try {
        return (JSON.parse(payload) as { choices?: { delta?: { content?: string } }[] }).choices?.[0]
          ?.delta?.content ?? '';
      } catch {
        return '';
      }
    })
    .join('');

describe('createSseRewriter —— 流式帧重写', () => {
  it('非 data 行原样保留（保住 SSE 分帧）', () => {
    const r = createSseRewriter();
    expect(r.rewrite('')).toEqual(['']);
    expect(r.rewrite(': keep-alive')).toEqual([': keep-alive']);
  });

  it('role 帧不动，content 帧被清洗', () => {
    const r = createSseRewriter();
    const roleFrame = `data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant' } }] })}`;
    expect(r.rewrite(roleFrame)[0]).toBe(roleFrame);

    const out: string[] = [];
    out.push(...r.rewrite(frame('您好，很高兴')));
    out.push(...r.rewrite(frame('为您服务')));
    out.push(...r.rewrite(frame('，今天怎么样')));
    out.push(...r.rewrite('data: [DONE]'));
    out.push(...r.flush());

    const text = textOf(out);
    expect(text).not.toContain('您');
    expect(text).not.toContain('很高兴');
    expect(text).toContain('今天怎么样');
    expect(r.text()).toBe(text);
  });

  it('[DONE] 之前先把扣住的尾巴补出去（不丢最后几个字）', () => {
    const r = createSseRewriter();
    const out: string[] = [];
    out.push(...r.rewrite(frame('这是一句很短的话')));
    // 此时内容还在清洗器的 hold 里，一个字都没放出去
    const doneLines = r.rewrite('data: [DONE]');
    out.push(...doneLines);
    const text = textOf(out);
    expect(text).toBe('这是一句很短的话');
    // 尾巴帧与 [DONE] 之间必须有空行，否则客户端会把两行当成同一个事件
    expect(doneLines[1]).toBe('');
    expect(doneLines.at(-1)).toBe('data: [DONE]');
  });

  it('拿得到 usage，且不重复输出尾巴', () => {
    const r = createSseRewriter();
    r.rewrite(frame('你好啊你好啊你好啊'));
    r.rewrite(`data: ${JSON.stringify({ choices: [], usage: { completion_tokens: 12 } })}`);
    expect(r.usage()).toEqual({ completion_tokens: 12 });

    r.rewrite('data: [DONE]');
    expect(r.flush()).toEqual([]);
  });

  it('流异常结束（没有 DONE）也能补完尾巴', () => {
    const r = createSseRewriter();
    const out: string[] = [];
    out.push(...r.rewrite(frame('还没说完就断了')));
    out.push(...r.flush());
    expect(textOf(out)).toBe('还没说完就断了');
  });

  it('无法解析的行原样放行，不吞内容', () => {
    const r = createSseRewriter();
    expect(r.rewrite('data: {broken json')).toEqual(['data: {broken json']);
  });

  it('正常文本逐帧拼接后与原文一致', () => {
    const r = createSseRewriter();
    const pieces = ['今天', '深圳', '二十六度', '，挺晒的'];
    const out: string[] = [];
    for (const p of pieces) out.push(...r.rewrite(frame(p)));
    out.push(...r.rewrite('data: [DONE]'));
    expect(textOf(out)).toBe('今天深圳二十六度，挺晒的');
  });
});
