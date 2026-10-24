import { describe, expect, it } from 'vitest';
import { mergeDailyLogs, missingDatesInMonth, completeConversationRows } from './jobs';
import { daysInMonth, subtractMonths } from './date';
import type { MessageRow } from './db';

const mk = (id: number): MessageRow => ({
  id,
  role: 'user',
  content: `m${id}`,
  turn_id: id,
  turn_type: 'chat',
  reply_to_id: null,
  channel: 'web',
  proactive_kind: null,
  cost_rmb: 0,
  prompt_tokens: 0,
  completion_tokens: 0,
  date_key: '2026-10-01',
  created_at: '2026-10-01T00:00:00+08:00',
  created_ms: 1790000000000,
});

describe('mergeDailyLogs', () => {
  it('无重叠时条数一致且按 id 升序', () => {
    const { merged, expected } = mergeDailyLogs([
      { messages: [mk(2), mk(1)] },
      { messages: [mk(3)] },
    ]);
    expect(expected).toBe(3);
    expect(merged.map((m) => m.id)).toEqual([1, 2, 3]);
  });

  it('重复 id 去重后少于 expected（完整性校验据此拦截）', () => {
    const { merged, expected } = mergeDailyLogs([
      { messages: [mk(1), mk(2)] },
      { messages: [mk(2), mk(3)] },
    ]);
    expect(expected).toBe(4);
    expect(merged.map((m) => m.id)).toEqual([1, 2, 3]);
  });

  it('空日志返回空结果', () => {
    expect(mergeDailyLogs([])).toEqual({ merged: [], expected: 0 });
  });
});

describe('subtractMonths', () => {
  it('普通减法与跨年', () => {
    expect(subtractMonths('2026-10-21', 3)).toBe('2026-07-21');
    expect(subtractMonths('2026-01-15', 3)).toBe('2025-10-15');
  });

  it('日超出目标月天数时钳制到月末', () => {
    expect(subtractMonths('2026-03-31', 1)).toBe('2026-02-28'); // 2026 非闰年
    expect(subtractMonths('2028-03-31', 1)).toBe('2028-02-29'); // 2028 闰年
  });
});

describe('daysInMonth', () => {
  it('大月/小月/平年二月/闰年二月', () => {
    expect(daysInMonth('2026-10')).toBe(31);
    expect(daysInMonth('2026-04')).toBe(30);
    expect(daysInMonth('2026-02')).toBe(28);
    expect(daysInMonth('2028-02')).toBe(29);
  });
});

describe('missingDatesInMonth', () => {
  it('找出全部缺失日期', () => {
    const missing = missingDatesInMonth('2026-10', [
      'chat_logs/2026-10-01.log',
      'chat_logs/2026-10-03.log',
    ]);
    expect(missing).toHaveLength(29);
    expect(missing).toContain('2026-10-02');
    expect(missing).not.toContain('2026-10-01');
    expect(missing).not.toContain('2026-10-03');
    expect(missing[missing.length - 1]).toBe('2026-10-31');
  });

  it('零日志时缺失整月', () => {
    expect(missingDatesInMonth('2026-10', [])).toHaveLength(31);
    expect(missingDatesInMonth('2026-02', [])).toHaveLength(28);
  });

  it('完整时为空', () => {
    const keys = Array.from({ length: 31 }, (_, i) => `chat_logs/2026-10-${String(i + 1).padStart(2, '0')}.log`);
    expect(missingDatesInMonth('2026-10', keys)).toEqual([]);
  });

  it('忽略非该月与 .json 文件', () => {
    const missing = missingDatesInMonth('2026-10', [
      'chat_logs/2026-10-01.log',
      'chat_logs/2026-09-30.log',
      'chat_logs/2026-10.json',
    ]);
    expect(missing).toHaveLength(30); // 只认当月 .log
  });
});

describe('completeConversationRows —— 归档以 AI 收尾', () => {
  const reply = (id: number): MessageRow => ({
    ...mk(999),
    id,
    role: 'assistant',
    content: `reply-${id}`,
    reply_to_id: 1,
  });

  it('最后一条是用户且回复落在下一天时补上', () => {
    const out = completeConversationRows([mk(1)], reply(2));
    expect(out.map((r) => r.id)).toEqual([1, 2]);
    expect(out[out.length - 1].role).toBe('assistant');
  });

  it('最后一条已经是 AI 时不改', () => {
    const rows = [mk(1), reply(2)];
    expect(completeConversationRows(rows, reply(3))).toBe(rows);
  });

  it('回复已在当天时不重复', () => {
    const rows = [mk(1), reply(2)];
    expect(completeConversationRows(rows, reply(2))).toBe(rows);
  });
});
