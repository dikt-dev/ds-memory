import { describe, expect, it } from 'vitest';
import {
  compactHistoryMessage,
  groupTurns,
  historyRangeNote,
  takeLastRounds,
  withHistoryTimestamp,
  type MessageRow,
} from './db';
import { resolveRecentRounds } from './recent-context';

const mk = (
  id: number,
  turnId: number,
  role: 'user' | 'assistant',
  content: string,
  createdAt: string,
): MessageRow => ({
  id,
  role,
  content,
  turn_id: turnId,
  turn_type: 'chat',
  reply_to_id: role === 'assistant' ? turnId : null,
  channel: 'web',
  proactive_kind: null,
  cost_rmb: 0,
  prompt_tokens: 0,
  completion_tokens: 0,
  date_key: createdAt.slice(0, 10),
  created_at: createdAt,
  created_ms: Date.parse(createdAt),
});

describe('groupTurns', () => {
  it('按 turn_id 把用户与回复归为一轮，按时间从旧到新', () => {
    const rows = [
      mk(3, 1, 'assistant', '第一轮回复', '2026-10-24T19:02:00+08:00'),
      mk(1, 1, 'user', '第一轮', '2026-10-24T19:01:00+08:00'),
      mk(4, 4, 'user', '第二轮', '2026-10-24T19:03:00+08:00'),
    ];
    const groups = groupTurns(rows);
    expect(groups.map((g) => g.map((m) => m.content))).toEqual([
      ['第一轮', '第一轮回复'],
      ['第二轮'],
    ]);
  });

  it('重复 id 只保留一次', () => {
    const a = mk(1, 1, 'user', 'a', '2026-10-24T19:01:00+08:00');
    expect(groupTurns([a, a])).toHaveLength(1);
  });
});

describe('takeLastRounds', () => {
  it('只保留最近 N 轮，且不把一轮拆开', () => {
    const rows = [
      mk(1, 1, 'user', 'a', '2026-10-24T19:01:00+08:00'),
      mk(2, 1, 'assistant', 'a2', '2026-10-24T19:02:00+08:00'),
      mk(3, 3, 'user', 'b', '2026-10-24T19:03:00+08:00'),
      mk(4, 3, 'assistant', 'b2', '2026-10-24T19:04:00+08:00'),
    ];
    const last = takeLastRounds(rows, 1);
    expect(last.map((m) => m.content)).toEqual(['b', 'b2']);
  });
});

describe('时间戳与顺序说明', () => {
  it('每条历史带 [MM-DD HH:mm] 前缀', () => {
    expect(withHistoryTimestamp('在吗', '2026-10-24T19:01:00+08:00')).toBe('[10-24 19:01] 在吗');
  });

  it('顺序说明明确提到轮数、从旧到新、不要输出时间标签', () => {
    const rows = [
      mk(1, 1, 'user', 'a', '2026-10-24T19:01:00+08:00'),
      mk(2, 1, 'assistant', 'a2', '2026-10-24T19:02:00+08:00'),
    ];
    const note = historyRangeNote(rows, new Date('2026-10-24T19:10:00+08:00'));
    expect(note).toContain('最近 1 轮');
    expect(note).toContain('从旧到新');
    expect(note).toContain('不要输出时间标签');
    expect(note).toContain('当前用户消息在它之后');
  });
});

describe('compactHistoryMessage', () => {
  it('短消息只做空白与图片路径清理', () => {
    expect(compactHistoryMessage('  你好\n\n[图片:images/2026-10-24/a.jpg]  ')).toBe('你好 [图片]');
  });

  it('超长消息保留开头与结尾，而不是只留开头', () => {
    const text = `开头${'中'.repeat(100)}结尾`;
    const out = compactHistoryMessage(text, 20);
    expect(out.startsWith('开头')).toBe(true);
    expect(out.endsWith('结尾')).toBe(true);
    expect(out).toContain('…');
    expect(out.length).toBeLessThanOrEqual(21);
  });
});

describe('resolveRecentRounds', () => {
  it('明确指代前文时取 50 轮', () => {
    expect(resolveRecentRounds('接着刚才那个问题继续说')).toBe(50);
    expect(resolveRecentRounds('继续前面那段代码')).toBe(50);
  });

  it('技术/长任务取 30 轮', () => {
    expect(resolveRecentRounds('帮我排查这个报错')).toBe(30);
    expect(resolveRecentRounds('继续实现项目的日志接口')).toBe(30);
  });

  it('普通聊天默认 15 轮', () => {
    expect(resolveRecentRounds('在吗')).toBe(15);
  });
});
