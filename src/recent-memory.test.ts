import { describe, expect, it } from 'vitest';
import {
  MEMO_INPUT_MAX_CHARS,
  MEMO_MIN_NEW_MESSAGES,
  MEMO_REFRESH_MESSAGES,
  MEMO_REFRESH_MS,
  buildMemoInput,
  formatRecentMemoBlock,
  hasEnoughNewMaterial,
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
    text: ['- 一起调了 AstrBot 文件插件', '随便一行非列表', '- 早上说北京太阳大', '- 下午提了 GBVS 补丁'].join('\n'),
    up_to_id: 42,
    updated_at: '2026-10-22T10:00:00.000Z',
  };

  it('只保留列表行，并加上标题', () => {
    const block = formatRecentMemoBlock(memo);
    expect(block.startsWith('## 最近一天（中期记忆）')).toBe(true);
    expect(block).toContain('- 一起调了 AstrBot 文件插件');
    expect(block).not.toContain('随便一行非列表');
  });

  it('超出条数时保留最新的几条', () => {
    const block = formatRecentMemoBlock(memo, 2);
    expect(block).toContain('- 下午提了 GBVS 补丁');
    expect(block).not.toContain('一起调了 AstrBot');
  });

  it('没有数据时返回空串（不污染提示词）', () => {
    expect(formatRecentMemoBlock(null)).toBe('');
    expect(formatRecentMemoBlock({ ...memo, text: '没有列表行' })).toBe('');
  });
});

describe('buildMemoInput', () => {
  const row = (role: string, content: string) => ({ role, turn_type: 'chat', content });

  it('有旧纪要时带上它，便于增量更新', () => {
    const input = buildMemoInput(
      { text: '- 旧：在修插件', up_to_id: 10, updated_at: '2026-10-22T10:00:00.000Z' },
      [row('user', '修好了')],
    );
    expect(input).toContain('【当前纪要】');
    expect(input).toContain('- 旧：在修插件');
    expect(input).toContain('【新增对话】');
    expect(input).toContain('用户：修好了');
  });

  it('没有旧纪要时不输出纪要段', () => {
    const input = buildMemoInput(null, [row('user', '在吗')]);
    expect(input).not.toContain('【当前纪要】');
    expect(input).toContain('用户：在吗');
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
