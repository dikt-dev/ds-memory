import { describe, expect, it } from 'vitest';
import {
  autoTags,
  bigrams,
  countNewLines,
  expandQuery,
  extractTags,
  mergeArchiveLines,
  parseArchiveLines,
  serializeArchiveLines,
  stripTags,
  withAutoTags,
} from './memory-archive';

const SAMPLE = [
  '- [2026-10-21] 凌晨四点睡醒无聊第一次聊天，从此认识',
  '- [2026-10-21] 手机部署 AstrBot 到凌晨三点，proot 一路踩坑',
  '- [2026-10-22] 买了 GBVS 全部 DLC，自嘲我是大冤种',
];

describe('档案序列化', () => {
  it('解析只保留 "- " 条目行', () => {
    const text = '# 记忆档案\n\n> 说明\n\n' + SAMPLE.join('\n') + '\n';
    expect(parseArchiveLines(text)).toEqual(SAMPLE);
  });

  it('序列化后能再解析回来（往返一致）', () => {
    const text = serializeArchiveLines(SAMPLE);
    expect(parseArchiveLines(text)).toEqual(SAMPLE);
    expect(text).toContain('# 记忆档案');
  });
});

describe('mergeArchiveLines', () => {
  it('同一内容不同日期保留两条（完整记录每次发生）', () => {
    const merged = mergeArchiveLines(
      ['- [2026-10-21] 第一次聊天'],
      ['- [2026-10-25] 第一次聊天。', '- [2026-10-22] 新的往事'],
    );
    expect(merged).toHaveLength(3);
    expect(merged.some((l) => l.includes('新的往事'))).toBe(true);
  });

  it('同一日期、带标签与不带标签的条目视为重复', () => {
    const merged = mergeArchiveLines(['- [2026-10-21] 通宵到三点 #作息'], ['- [2026-10-21] 通宵到三点']);
    expect(merged).toHaveLength(1);
  });

  it('不再丢最旧条目，档案完整保留', () => {
    const existing = Array.from({ length: 5000 }, (_, i) => `- [2026-10-01] 旧事${i}`);
    const merged = mergeArchiveLines(existing, ['- [2026-10-22] 最新的一条']);
    expect(merged).toHaveLength(5001);
    expect(merged.at(-1)).toContain('最新的一条');
    expect(merged[0]).toContain('旧事0');
  });
});

describe('countNewLines', () => {
  it('只数真正新增的（已存在与重复都不算）', () => {
    expect(
      countNewLines(['- [2026-10-21] A'], ['- [2026-10-21] A', '- [2026-10-22] B', '- [2026-10-22]  B。']),
    ).toBe(1);
  });

  it('档案不再因上限丢旧条目，新增计数仍然正确', () => {
    const existing = Array.from({ length: 5000 }, (_, i) => `- [2026-10-01] 旧事${i}`);
    expect(countNewLines(existing, ['- [2026-10-22] 全新的一条'])).toBe(1);
  });
});

describe('bigrams', () => {
  it('去掉标点与空白后再切 2-gram', () => {
    expect(bigrams('你好，世界')).toEqual(['你好', '好世', '世界']);
    expect(bigrams('')).toEqual([]);
    expect(bigrams('啊')).toEqual([]);
  });

  it('统一小写、忽略标签', () => {
    expect(bigrams('GBVS')).toEqual(['gb', 'bv', 'vs']);
    expect(bigrams('通宵 #作息')).toEqual(['通宵']);
  });
});

describe('标签', () => {
  it('自动打标签（作息/技术等）', () => {
    expect(autoTags('手机部署 AstrBot 到凌晨三点')).toEqual(['作息', '技术']);
    expect(autoTags('买了个新键盘')).toEqual([]);
  });

  it('已有标签时不重复添加', () => {
    const once = withAutoTags('- [2026-10-21] 通宵到三点');
    expect(once).toContain('#作息');
    expect(withAutoTags(once)).toBe(once);
  });

  it('提取与剥离标签', () => {
    const line = '- [2026-10-21] 通宵到三点 #作息 #技术';
    expect(extractTags(line)).toEqual(['作息', '技术']);
    expect(stripTags(line)).toBe('- [2026-10-21] 通宵到三点');
  });
});

describe('expandQuery（同义词扩展）', () => {
  it('命中组内任一词时补齐其它说法', () => {
    const expanded = expandQuery('昨晚又熬夜了');
    expect(expanded).toContain('通宵');
    expect(expanded).toContain('凌晨');
  });

  it('无关查询原样返回', () => {
    expect(expandQuery('今天天气不错')).toBe('今天天气不错');
  });
});


