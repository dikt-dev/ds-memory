import { describe, expect, it } from 'vitest';
import {
  MEMO_INPUT_MAX_CHARS,
  MEMO_MIN_NEW_MESSAGES,
  MEMO_REFRESH_MESSAGES,
  MEMO_REFRESH_MS,
  MEMO_WINDOW_MS,
  buildMemoInput,
  formatRecentMemoBlock,
  hasEnoughNewMaterial,
  mergeMemoItems,
  parseLegacyMemo,
  parseMemoItems,
  pickKeyLines,
  shouldRefreshRecentMemo,
} from './recent-memory';

describe('shouldRefreshRecentMemo', () => {
  it('新消息达到阈值就刷新', () => {
    expect(shouldRefreshRecentMemo({ newMessages: MEMO_REFRESH_MESSAGES, ageMs: 0 })).toBe(true);
    expect(shouldRefreshRecentMemo({ newMessages: MEMO_REFRESH_MESSAGES - 1, ageMs: 0 })).toBe(false);
  });

  it('距上次超过 3 小时也刷新', () => {
    expect(shouldRefreshRecentMemo({ newMessages: 0, ageMs: MEMO_REFRESH_MS })).toBe(true);
    expect(shouldRefreshRecentMemo({ newMessages: 0, ageMs: MEMO_REFRESH_MS - 1 })).toBe(false);
  });

  it('首次（无历史）直接刷新', () => {
    expect(shouldRefreshRecentMemo({ newMessages: 1, ageMs: Number.POSITIVE_INFINITY })).toBe(true);
  });
});

describe('hasEnoughNewMaterial', () => {
  it('增量太少不值得调模型', () => {
    expect(hasEnoughNewMaterial(MEMO_MIN_NEW_MESSAGES - 1, false)).toBe(false);
    expect(hasEnoughNewMaterial(MEMO_MIN_NEW_MESSAGES, false)).toBe(true);
  });

  it('消息表被重置时强制重算（up_to_id 已失效）', () => {
    expect(hasEnoughNewMaterial(0, true)).toBe(true);
  });
});

describe('formatRecentMemoBlock', () => {
  const memo = {
    items: [
      { at: '2026-10-22T08:00:00+08:00', text: '一起调了 AstrBot 文件插件' },
      { at: '2026-10-22T09:00:00+08:00', text: '早上说北京太阳大' },
      { at: '2026-10-22T15:00:00+08:00', text: '下午提了 GBVS 补丁' },
    ],
    up_to_id: 42,
    updated_at: '2026-10-22T10:00:00.000Z',
  };

  it('带上标题，每条带时间锚', () => {
    const block = formatRecentMemoBlock(memo);
    expect(block.startsWith('## 最近三天（中期记忆）')).toBe(true);
    expect(block).toContain('10/22 08:00] 一起调了 AstrBot 文件插件');
  });

  it('超出条数时保留最新的几条', () => {
    const block = formatRecentMemoBlock(memo, 1);
    expect(block).toContain('下午提了 GBVS 补丁');
    expect(block).not.toContain('一起调了 AstrBot');
  });

  it('被取代的条目不注入', () => {
    const withOld = {
      ...memo,
      items: [...memo.items, { at: '2026-10-22T16:00:00+08:00', text: '已经过时', superseded: true }],
    };
    expect(formatRecentMemoBlock(withOld)).not.toContain('已经过时');
  });

  it('落在当前会话时间范围内的条目不重复注入（O4）', () => {
    const sessionStart = Date.parse('2026-10-22T14:00:00+08:00');
    const block = formatRecentMemoBlock(memo, 24, sessionStart);
    expect(block).not.toContain('下午提了 GBVS 补丁');
    expect(block).toContain('一起调了 AstrBot 文件插件');
  });

  it('没有数据时返回空串（不污染提示词）', () => {
    expect(formatRecentMemoBlock(null)).toBe('');
    expect(formatRecentMemoBlock({ ...memo, items: [] })).toBe('');
  });
});

describe('buildMemoInput', () => {
  const row = (role: string, content: string) => ({ role, turn_type: 'chat', content });

  it('有旧纪要时带上它，便于增量更新', () => {
    const input = buildMemoInput(
      {
        items: [{ at: '2026-10-22T09:00:00+08:00', text: '旧：在修插件' }],
        up_to_id: 10,
        updated_at: '2026-10-22T10:00:00.000Z',
      },
      [row('user', '修好了')],
    );
    expect(input).toContain('【当前纪要】');
    expect(input).toContain('旧：在修插件');
    expect(input).toContain('【新增对话】');
    expect(input).toContain('他：修好了');
  });

  it('没有旧纪要时不输出纪要段', () => {
    const input = buildMemoInput(null, [row('user', '在吗')]);
    expect(input).not.toContain('【当前纪要】');
    expect(input).toContain('他：在吗');
  });

  it('超长时保留最新对话（丢弃最早的）', () => {
    const rows = [
      row('user', '老消息'.repeat(MEMO_INPUT_MAX_CHARS)),
      row('user', '最新的一句'),
    ];
    const input = buildMemoInput(null, rows);
    expect(input).toContain('最新的一句');
    expect(input.length).toBeLessThan(MEMO_INPUT_MAX_CHARS + 200);
  });

  it('主动消息标注来源，避免被当成用户说的话', () => {
    const input = buildMemoInput(null, [{ role: 'assistant', turn_type: 'proactive', content: '在想你' }]);
    expect(input).toContain('助手（主动发起）：在想你');
  });
});

describe('中期记忆改版（O1~O4）', () => {
  it('覆盖窗口是 3 天', () => {
    expect(MEMO_WINDOW_MS).toBe(3 * 24 * 60 * 60 * 1000);
  });

  it('新条目追加，旧条目原文不变（O2）', () => {
    const prev = [{ at: '2026-10-21T09:00:00+08:00', text: '在改记忆系统' }];
    const added = [{ at: '2026-10-21T15:00:00+08:00', text: '召回延迟 500ms' }];
    const merged = mergeMemoItems(prev, added);
    expect(merged[0].text).toBe('在改记忆系统');
    expect(merged[1].text).toBe('召回延迟 500ms');
  });

  it('重复条目不重复添加', () => {
    const prev = [{ at: '2026-10-21T09:00:00+08:00', text: '在改记忆系统' }];
    const merged = mergeMemoItems(prev, [{ at: '2026-10-21T10:00:00+08:00', text: '在改记忆系统' }]);
    expect(merged).toHaveLength(1);
  });

  it('超出 3 天窗口的条目被丢掉', () => {
    const old = { at: '2026-10-18T09:00:00+08:00', text: '很久以前' };
    const fresh = { at: '2026-10-22T09:00:00+08:00', text: '今天' };
    const merged = mergeMemoItems([old, fresh], [], 48, Date.parse('2026-10-19T12:00:00+08:00'));
    expect(merged.map((i) => i.text)).toEqual(['今天']);
  });

  it('解析模型输出时认时间锚，没有锚就用刷新时间', () => {
    const out = ['- [10/21 14:30] 决定换工作', '- 没有时间锚的一句'].join('\n');
    const items = parseMemoItems(out, '2026-10-22T10:00:00.000Z');
    expect(items[0].text).toBe('决定换工作');
    expect(items[0].at).toContain('2026-10-21T14:30');
    expect(items[1].at).toBe('2026-10-22T10:00:00.000Z');
  });

  it('旧格式（一整段 - 列表）能迁移成条目', () => {
    const items = parseLegacyMemo('- 第一条\n- 第二条', '2026-10-21T09:00:00.000Z');
    expect(items.map((i) => i.text)).toEqual(['第一条', '第二条']);
  });

  it('规则预筛优先挑含决定/约定/状态的句子（O3）', () => {
    const rows = [
      { role: 'user', turn_type: 'chat', content: '哈哈哈' },
      { role: 'user', turn_type: 'chat', content: '明天要去面试' },
      { role: 'user', turn_type: 'chat', content: '今天好累' },
      { role: 'user', turn_type: 'chat', content: '我决定下个月搬家' },
      { role: 'assistant', turn_type: 'chat', content: '那就好好休息' },
    ];
    const picked = pickKeyLines(rows);
    const texts = picked.map((r) => r.content);
    expect(texts).toContain('明天要去面试');
    expect(texts).toContain('我决定下个月搬家');
    expect(texts).not.toContain('哈哈哈');
  });

  it('筛不出关键句时退回最近若干行（不能没材料）', () => {
    const rows = [
      { role: 'user', turn_type: 'chat', content: '哈哈' },
      { role: 'user', turn_type: 'chat', content: '嗯嗯' },
    ];
    expect(pickKeyLines(rows)).toHaveLength(2);
  });
});