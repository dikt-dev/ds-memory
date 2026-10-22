import { describe, expect, it } from 'vitest';
import { archiveCompletedItems } from './memory-maintenance';
import {
  accumulateCandidates,
  extractTopic,
  formatAversionEntry,
  mergeAversionEntries,
  scanAversions,
  type AversionCandidate,
} from './aversion';

describe('archiveCompletedItems —— 已完成事项自动归档', () => {
  const withPending = (pending: string[], shared?: string[]) =>
    [
      '# 长期记忆',
      '',
      '## 进行中的事项',
      '',
      '- [2026-10-20] [进行中] 测试 AstrBot 连通性',
      ...pending,
      '',
      '## 共同经历',
      '',
      ...(shared ?? []),
    ].join('\n');

  it('刚标完成时不动（宽限期内）', () => {
    const text = withPending(['- [2026-10-22] [已完成] 写完需求文档']);
    const r = archiveCompletedItems(text, '2026-10-22'); // 当天标完成
    expect(r.moved).toBe(0);
    expect(r.text).toContain('[已完成] 写完需求文档');
  });

  it('超过宽限期后归档到共同经历', () => {
    const text = withPending(['- [2026-10-10] [已完成] 写完需求文档']);
    const r = archiveCompletedItems(text, '2026-10-22'); // 12 天前完成
    expect(r.moved).toBe(1);
    expect(r.text).toContain('## 共同经历');
    expect(r.text).toContain('完成了：写完需求文档');
    // 原分区里已移除
    expect(r.text).not.toContain('[已完成] 写完需求文档');
  });

  it('归档时去掉 [已完成] 标记', () => {
    const text = withPending(['- [2026-10-01] [已完成] 修完 bug']);
    const r = archiveCompletedItems(text, '2026-10-22');
    expect(r.text).toContain('完成了：修完 bug');
    expect(r.text).not.toMatch(/完成了：.*\[已完成\]/);
  });

  it('进行中的条目不受影响', () => {
    const text = withPending([
      '- [2026-10-01] [进行中] 长期项目',
      '- [2026-10-02] [搁置] 暂时不做的',
      '- [2026-10-03] [已完成] 已完成的任务',
    ]);
    const r = archiveCompletedItems(text, '2026-10-22');
    expect(r.moved).toBe(1);
    expect(r.text).toContain('[进行中] 长期项目');
    expect(r.text).toContain('[搁置] 暂时不做的');
  });

  it('没有已完成项时原样返回', () => {
    const text = withPending(['- [2026-10-20] [进行中] 项目 A']);
    const r = archiveCompletedItems(text, '2026-10-22');
    expect(r.moved).toBe(0);
    expect(r.text).toBe(text);
  });

  it('返回归档项标题便于日志', () => {
    const text = withPending(['- [2026-10-01] [已完成] 上线新版本']);
    const r = archiveCompletedItems(text, '2026-10-22');
    expect(r.titles.length).toBe(1);
    expect(r.titles[0]).toContain('上线新版本');
  });

  it('没有「进行中的事项」分区时不报错', () => {
    const text = '# 长期记忆\n\n## 关于用户\n\n- [2026-10-01] 事实';
    const r = archiveCompletedItems(text, '2026-10-22');
    expect(r.moved).toBe(0);
  });
});

describe('scanAversions —— 反感信号识别', () => {
  it('识别明确拒绝', () => {
    const r = scanAversions(['不想聊这个了', '我们聊点别的吧']);
    expect(r.hits.length).toBeGreaterThan(0);
    expect(r.totalWeight).toBeGreaterThanOrEqual(3);
  });

  it('识别不耐烦', () => {
    const r = scanAversions(['烦死了', '别问了']);
    expect(r.totalWeight).toBeGreaterThan(0);
  });

  it('识别创伤线索', () => {
    const r = scanAversions(['那件事我有心理阴影']);
    expect(r.totalWeight).toBeGreaterThan(0);
  });

  it('普通对话不误判', () => {
    const r = scanAversions(['今天天气不错', '帮我查个资料']);
    expect(r.hits.length).toBe(0);
    expect(r.totalWeight).toBe(0);
  });

  it('正常情绪低落不算反感', () => {
    // 「难过」是情绪，不是对这个话题的反感
    const r = scanAversions(['今天有点难过']);
    expect(r.totalWeight).toBe(0);
  });
});

describe('extractTopic —— 话题提取', () => {
  it('从消息中提取关键词', () => {
    const t = extractTopic('我最近在准备考研的事情');
    expect(t.length).toBeGreaterThan(0);
    expect(['考研', '准备考研', '最近在准备考研的事情'].some((x) => t.includes(x) || x.includes(t))).toBe(true);
  });

  it('过滤语气词', () => {
    const t = extractTopic('嗯嗯，好的，知道了');
    // 不应该返回「知道了」这类无意义词
    expect(t).not.toBe('知道了');
  });

  it('空文本返回空串', () => {
    expect(extractTopic('')).toBe('');
    expect(extractTopic('12345')).toBe('');
  });
});

describe('accumulateCandidates —— 累计与晋升', () => {
  it('弱信号首次命中不晋升（只进候选池）', () => {
    // 「不想提」 weight=2，单次不足以晋升（需累计或强信号）
    const scan = scanAversions(['这件事我不想提']);
    const { pool, promoted } = accumulateCandidates([], scan, '2026-10-22');
    expect(pool.length).toBeGreaterThan(0);
    expect(promoted.length).toBe(0);
  });

  it('同一弱信号累计 2 次后晋升', () => {
    const scan1 = scanAversions(['这件事我不想提']);
    const r1 = accumulateCandidates([], scan1, '2026-10-21');
    const scan2 = scanAversions(['这件事我不想提']);
    const r2 = accumulateCandidates(r1.pool, scan2, '2026-10-22');

    expect(r2.promoted.length).toBe(1);
  });

  it('极强信号（weight >= 3）单次即可晋升', () => {
    const scan = scanAversions(['换个话题吧']);
    // 「换个话题」weight 3
    const { promoted } = accumulateCandidates([], scan, '2026-10-22');
    expect(promoted.length).toBeGreaterThanOrEqual(1);
  });

  it('已晋升的不会重复晋升', () => {
    const scan = scanAversions(['换个话题吧']);
    const r1 = accumulateCandidates([], scan, '2026-10-22');
    const r2 = accumulateCandidates(r1.pool, scan, '2026-10-23');
    // 第二次不应再晋升同一话题
    expect(r2.promoted.length).toBe(0);
  });
});

describe('formatAversionEntry / mergeAversionEntries', () => {
  const candidate: AversionCandidate = {
    topic: '加班',
    score: 5,
    count: 2,
    lastDate: '2026-10-22',
    sample: '不想聊加班的事',
  };

  it('格式化为记忆条目', () => {
    const entry = formatAversionEntry(candidate);
    expect(entry).toContain('[2026-10-22]');
    expect(entry).toContain('加班');
    expect(entry).toContain('避免');
  });

  it('并入雷区分区', () => {
    const memory = '# 长期记忆\n\n## 雷区与禁忌\n\n<!-- 注释 -->\n\n## 近期动态\n\n- [2026-10-22] 测试';
    const entry = formatAversionEntry(candidate);
    const out = mergeAversionEntries(memory, [entry]);
    expect(out).toContain('加班');
    // 应该在雷区分区内，而不是跑到近期动态
    const rejIdx = out.indexOf('## 雷区与禁忌');
    const recentIdx = out.indexOf('## 近期动态');
    const entryIdx = out.indexOf('加班');
    expect(entryIdx).toBeGreaterThan(rejIdx);
    expect(entryIdx).toBeLessThan(recentIdx);
  });

  it('已存在时不重复添加', () => {
    const memory = '# 长期记忆\n\n## 雷区与禁忌\n\n- [2026-10-20] 避免主动聊「加班」';
    const entry = formatAversionEntry(candidate);
    const out = mergeAversionEntries(memory, [entry]);
    expect((out.match(/加班/g) || []).length).toBe(1);
  });

  it('没有雷区分区时不动', () => {
    const memory = '# 长期记忆\n\n## 关于用户\n\n- [2026-10-01] 事实';
    const out = mergeAversionEntries(memory, ['- [2026-10-22] 避免聊加班']);
    expect(out).toBe(memory);
  });
});
