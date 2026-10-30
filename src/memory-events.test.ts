import { describe, expect, it } from 'vitest';
import {
  EVENT_GAP_MS,
  EVENT_MAX_MESSAGES,
  parseEventJson,
  segmentEvents,
  validateQuotes,
  type EventSourceRow,
} from './memory-events';

const row = (id: number, ms: number, content: string, role: 'user' | 'assistant' = 'user'): EventSourceRow => ({
  id,
  role,
  content,
  created_ms: ms,
});

describe('segmentEvents', () => {
  it('间隔超过 45 分钟就切新事件', () => {
    const base = Date.parse('2026-10-30T12:00:00+08:00');
    const rows = [
      row(1, base, 'a'),
      row(2, base + 10 * 60 * 1000, 'b'),
      row(3, base + 10 * 60 * 1000 + EVENT_GAP_MS + 1000, 'c'),
    ];
    const chunks = segmentEvents(rows);
    expect(chunks.map((c) => c.map((m) => m.content))).toEqual([['a', 'b'], ['c']]);
  });

  it('连续对话保持同一个事件', () => {
    const base = Date.parse('2026-10-30T12:00:00+08:00');
    const rows = [1, 2, 3].map((i) => row(i, base + i * 60_000, 'm' + i));
    expect(segmentEvents(rows)).toHaveLength(1);
  });

  it('单个事件不超过上限条数', () => {
    const base = Date.parse('2026-10-30T12:00:00+08:00');
    const rows = Array.from({ length: EVENT_MAX_MESSAGES + 5 }, (_, i) => row(i + 1, base + i * 1000, 'm' + i));
    const chunks = segmentEvents(rows);
    expect(chunks[0]).toHaveLength(EVENT_MAX_MESSAGES);
    expect(chunks).toHaveLength(2);
  });

  it('乱序输入按时间排好再切', () => {
    const base = Date.parse('2026-10-30T12:00:00+08:00');
    const rows = [row(2, base + 5000, 'later'), row(1, base, 'earlier')];
    expect(segmentEvents(rows)[0].map((m) => m.content)).toEqual(['earlier', 'later']);
  });
});

describe('validateQuotes', () => {
  const rows = [
    row(1, 1, '那个视频剪得挺好，我也想学'),
    row(2, 2, '你连剪映都没打开过吧', 'assistant'),
  ];

  it('只保留能在原文里原样找到的引文', () => {
    const out = validateQuotes(['我也想学', '这句是模型编的'], rows);
    expect(out).toEqual(['我也想学']);
  });

  it('模型改写的引文一律丢掉', () => {
    expect(validateQuotes(['那个视频剪得很好，我想学'], rows)).toEqual([]);
  });

  it('太短的引文不要（容易误配）', () => {
    expect(validateQuotes(['我'], rows)).toEqual([]);
  });
});

describe('parseEventJson', () => {
  it('吃掉 markdown 代码块也能解析', () => {
    const raw = '```json\n{"title":"改记忆","summary":"聊了记忆系统"}\n```';
    expect(parseEventJson(raw)?.title).toBe('改记忆');
  });

  it('坏 JSON 返回 null，不抛异常', () => {
    expect(parseEventJson('不是 JSON')).toBeNull();
    expect(parseEventJson('')).toBeNull();
  });

  it('前后有解释文字也能取出 JSON', () => {
    expect(parseEventJson('好的，结果如下：{"title":"x"} 希望有帮助')?.title).toBe('x');
  });
});