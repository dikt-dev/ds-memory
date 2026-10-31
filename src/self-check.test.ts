import { describe, expect, it } from 'vitest';
import { findOrphans, findQuoteMismatches, type SelfCheckEvent } from './self-check';

function event(over: Partial<SelfCheckEvent> = {}): SelfCheckEvent {
  return {
    id: 1,
    msg_ids: '[101,102]',
    quotes: '["今天不走回滚"]',
    importance: 3,
    status: 'active',
    ...over,
  };
}

describe('findQuoteMismatches', () => {
  const messages = new Map<number, string>([
    [101, '算了今天不走回滚，明天再说'],
    [102, '嗯'],
  ]);

  it('逐字对得上：没有不一致', () => {
    expect(findQuoteMismatches([event()], messages)).toEqual([]);
  });

  it('忽略空白与引号差异', () => {
    const ev = event({ quotes: '["今天不走回滚，明天再说"]' });
    expect(findQuoteMismatches([ev], messages)).toEqual([]);
  });

  it('对不上原文：报不一致', () => {
    const ev = event({ quotes: '["她从来没这么说过"]' });
    const out = findQuoteMismatches([ev], messages);
    expect(out).toHaveLength(1);
    expect(out[0].reason).toBe('not_in_messages');
    expect(out[0].eventId).toBe(1);
  });

  it('没有 msg_ids：报 no_messages', () => {
    const ev = event({ msg_ids: '[]' });
    const out = findQuoteMismatches([ev], messages);
    expect(out[0].reason).toBe('no_messages');
  });

  it('坏 JSON 不会抛异常', () => {
    const ev = event({ msg_ids: 'not-json', quotes: 'also-bad' });
    expect(() => findQuoteMismatches([ev], messages)).not.toThrow();
    expect(findQuoteMismatches([ev], messages)).toEqual([]);
  });

  it('D1 里没有原文、但归档里有：不算不一致（真实场景：隔天清理）', () => {
    const ev = event();
    const archived = new Map<number, string>([
      [101, '算了今天不走回滚，明天再说'],
      [102, '嗯'],
    ]);
    expect(findQuoteMismatches([ev], new Map(), archived)).toEqual([]);
  });

  it('D1 和归档都没有原文：视为无法校验，不判造假', () => {
    const ev = event();
    expect(findQuoteMismatches([ev], new Map(), new Map())).toEqual([]);
  });

  it('一部分消息还在 D1，引文能对上就不报', () => {
    const ev = event({ msg_ids: '[101,999]' });
    const archived = new Map<number, string>([[999, '今天的另一句']]);
    expect(findQuoteMismatches([ev], messages, archived)).toEqual([]);
  });

  it('引文太短（<4 字）不判', () => {
    const ev = event({ quotes: '["嗯"]' });
    expect(findQuoteMismatches([ev], messages)).toEqual([]);
  });

  it('多条事件各自判定', () => {
    const out = findQuoteMismatches(
      [event({ id: 1 }), event({ id: 2, quotes: '["这句话是编出来的"]' })],
      messages,
    );
    expect(out.map((m) => m.eventId)).toEqual([2]);
  });
});

describe('findOrphans', () => {
  const existing = new Set([10, 11, 12]);

  it('全部出处都在：不是孤儿', () => {
    expect(findOrphans([{ kind: 'fact', id: 'f1', sourceMessageIds: [10, 11] }], existing)).toEqual([]);
  });

  it('有出处指向不存在的消息：算孤儿并列出缺的 id', () => {
    const out = findOrphans([{ kind: 'fact', id: 'f2', sourceMessageIds: [10, 99] }], existing);
    expect(out).toHaveLength(1);
    expect(out[0].missing).toEqual([99]);
  });

  it('没有出处的事实不判孤儿（由证据门负责）', () => {
    expect(findOrphans([{ kind: 'fact', id: 'f3', sourceMessageIds: [] }], existing)).toEqual([]);
  });

  it('chunk 也参与检测', () => {
    const out = findOrphans([{ kind: 'chunk', id: 'c1', sourceMessageIds: [77] }], existing);
    expect(out[0].kind).toBe('chunk');
  });
});
