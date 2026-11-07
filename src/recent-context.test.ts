import { describe, expect, it } from 'vitest';
import {
  compactHistoryMessage,
  groupTurns,
  historyRangeNote,
  takeLastRounds,
  withHistoryTimestamp,
  type MessageRow,
} from './db';
import {
  trimHistoryToBudget,
  buildSessionBrief,
  conversationGapNote,
  resolveRecentRounds,
  sliceCurrentSession,
} from './recent-context';

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
  it('每条历史只带 [MM-DD HH:mm]，不再带说话人标签', () => {
    expect(withHistoryTimestamp('在吗', '2026-10-24T19:01:00+08:00')).toBe('[10-24 19:01] 在吗');
    expect(withHistoryTimestamp('在吗', '2026-10-24T19:01:00+08:00')).toBe('[10-24 19:01] 在吗');
    expect(withHistoryTimestamp('在呢', '2026-10-24T19:01:00+08:00')).toBe('[10-24 19:01] 在呢');
  });

  it('顺序说明明确提到轮数、从旧到新、不要输出时间标签', () => {
    const rows = [
      mk(1, 1, 'user', 'a', '2026-10-24T19:01:00+08:00'),
      mk(2, 1, 'assistant', 'a2', '2026-10-24T19:02:00+08:00'),
    ];
    const note = historyRangeNote(rows, new Date('2026-10-24T19:10:00+08:00'));
    expect(note).toContain('最近 1 轮');
    expect(note).toContain('从旧到新');
    expect(note).toContain('不要输出时间');
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
    expect(resolveRecentRounds('接着刚才那个问题继续说')).toBe(60);
    expect(resolveRecentRounds('继续前面那段代码')).toBe(60);
  });

  it('技术/长任务取 30 轮', () => {
    expect(resolveRecentRounds('帮我排查这个报错')).toBe(60);
    expect(resolveRecentRounds('继续实现项目的日志接口')).toBe(60);
  });

  it('普通聊天默认 15 轮', () => {
    expect(resolveRecentRounds('在吗')).toBe(30);
  });
});

describe('conversationGapNote', () => {
  it('按最后一条历史消息计算间隔', () => {
    const rows = [mk(1, 1, 'user', '在吗', '2026-10-27T14:00:00+08:00')];
    const note = conversationGapNote(rows, new Date('2026-10-27T16:00:00+08:00'));
    expect(note).toContain('距上次对话');
    expect(note).toContain('2 小时');
  });

  it('没有历史时明确标成第一次对话', () => {
    expect(conversationGapNote([], new Date())).toContain('第一次对话');
  });
});

describe('会话级短期记忆（A+B+C）', () => {
  const row = (id: number, turn: number, role: 'user' | 'assistant', text: string, at: string) =>
    mk(id, turn, role, text, at);

  it('超过 6 小时的长间隔切出新会话', () => {
    const rows = [
      row(1, 1, 'user', '早上那句', '2026-10-30T08:00:00+08:00'),
      row(2, 2, 'user', '下午第一句', '2026-10-30T15:00:00+08:00'),
      row(3, 3, 'user', '下午第二句', '2026-10-30T15:05:00+08:00'),
    ];
    const session = sliceCurrentSession(rows);
    expect(session.map((m) => m.content)).toEqual(['下午第一句', '下午第二句']);
  });

  it('间隔不足 6 小时不切，整段留着', () => {
    const rows = [
      row(1, 1, 'user', 'a', '2026-10-30T08:00:00+08:00'),
      row(2, 2, 'user', 'b', '2026-10-30T13:59:00+08:00'),
    ];
    expect(sliceCurrentSession(rows)).toHaveLength(2);
  });

  it('只追加不滑窗：下一轮的历史以上一轮为前缀（缓存命中的前提）', () => {
    const base = [
      row(1, 1, 'user', 'a', '2026-10-30T08:00:00+08:00'),
      row(2, 1, 'assistant', 'a2', '2026-10-30T08:01:00+08:00'),
    ];
    const next = [...base, row(3, 3, 'user', 'b', '2026-10-30T08:05:00+08:00')];
    const prevSession = sliceCurrentSession(base);
    const nextSession = sliceCurrentSession(next);
    expect(nextSession.slice(0, prevSession.length).map((m) => m.id)).toEqual(prevSession.map((m) => m.id));
  });

  it('提要是确定性函数：同样的行永远得到同样的文本', () => {
    const rows = [
      row(1, 1, 'user', '想换工作', '2026-10-30T08:00:00+08:00'),
      row(2, 1, 'assistant', '那就先看看岗位', '2026-10-30T08:01:00+08:00'),
    ];
    expect(buildSessionBrief(rows)).toBe(buildSessionBrief(rows));
    expect(buildSessionBrief(rows)).toContain('提要');
  });

  it('提要长度受控，80 轮也不会爆', () => {
    const rows = [];
    for (let i = 1; i <= 160; i++) {
      rows.push(row(i, i, i % 2 ? 'user' : 'assistant', '第' + i + '条消息内容', '2026-10-30T08:00:00+08:00'));
    }
    const brief = buildSessionBrief(rows);
    expect(brief.length).toBeLessThanOrEqual(700);
  });

  it('空输入返回空串', () => {
    expect(buildSessionBrief([])).toBe('');
  });
});

describe('trimHistoryToBudget —— 按体积裁历史', () => {
  const row = (id: number, turn: number, role: 'user' | 'assistant', content: string) => ({
    id, turn_id: turn, role, content, created_at: '', created_ms: id, date_key: '2026-11-06',
  }) as never;

  it('超预算时丢掉更早的整轮，至少留一轮', () => {
    const rows = [
      row(1, 1, 'user', 'a'.repeat(400)),
      row(2, 1, 'assistant', 'b'.repeat(400)),
      row(3, 2, 'user', 'c'.repeat(400)),
      row(4, 2, 'assistant', 'd'.repeat(400)),
    ];
    const out = trimHistoryToBudget(rows, 900);
    expect(out.map((m: any) => m.id)).toEqual([3, 4]);
  });

  it('预算足够时原样返回', () => {
    const rows = [row(1, 1, 'user', '在吗'), row(2, 1, 'assistant', '在')];
    expect(trimHistoryToBudget(rows, 1000)).toHaveLength(2);
  });
});