import { describe, expect, it } from 'vitest';
import {
  byteLength,
  compactMemoryEntries,
  memoryDensity,
  demoteSectionEntries,
  demoteSectionToBudget,
  ensureModuleComments,
  mergeMemoryEntry,
  parseRelationValues,
  pruneTransientSections,
  reportSectionBudgets,
  splitMemoryForPrompt,
  trimOldestEntries,
} from './memory-maintenance';

const SAMPLE = `# 长期记忆

> 系统维护

## 关于他
- [2026-10-01] 旧事实A。
- [2026-10-01] 旧事实B。

## 他的偏好
- [2026-10-10] 偏好C。

## 进行中的事
- [2026-10-20] 最新D。
`;

describe('byteLength', () => {
  it('按 UTF-8 字节计数', () => {
    expect(byteLength('abc')).toBe(3);
    expect(byteLength('中文')).toBe(6);
  });
});

describe('mergeMemoryEntry', () => {
  it('重复条目不追加', () => {
    const distilled = `## 关于他
- [2026-10-01] 旧事实A。`;
    const out = mergeMemoryEntry(SAMPLE, distilled, '2026-10-21');
    expect(out).toBe(SAMPLE); // 无变化
  });

  it('新条目合并进已有分类，缺日期时补 fallback 日期', () => {
    const distilled = `## 他的偏好
- 喜欢深夜工作。
## 全新分类
- [2026-10-21] 某条信息。`;
    const out = mergeMemoryEntry(SAMPLE, distilled, '2026-10-21');
    expect(out).toContain('- [2026-10-21] 喜欢深夜工作。');
    expect(out).toContain('## 全新分类');
    expect(out).toContain('- [2026-10-21] 某条信息。');
    // 原有内容保留
    expect(out).toContain('- [2026-10-20] 最新D。');
    // 分类顺序：原分类在前，新分类追加在后
    expect(out.indexOf('## 关于他')).toBeLessThan(out.indexOf('## 全新分类'));
  });

  it('裸 bullet（没有分区标题）落到近期动态，不静默丢失', () => {
    const distilled = `- [26-10-26] 裸条目一
- [26-10-26] 裸条目二`;
    const out = mergeMemoryEntry(SAMPLE, distilled, '2026-10-26');
    expect(out).toContain('## 近期动态');
    expect(out).toContain('- [26-10-26] 裸条目一');
    expect(out).toContain('- [26-10-26] 裸条目二');
  });

  it('提炼结果无有效条目时原样返回', () => {
    expect(mergeMemoryEntry(SAMPLE, '今天没什么可记的。', '2026-10-21')).toBe(SAMPLE);
  });
});

describe('pruneTransientSections', () => {
  it('删除近期动态里带日期的旧关系快照，保留当前称呼区数值', () => {
    const text = `# 长期记忆

## 称呼与关系
- 心情值：547 / 1000

## 近期动态
- [2026-10-24] 心情值：560 / 1000
- [2026-10-27] 今天很开心
`;
    const r = pruneTransientSections(text, '2026-10-28');
    expect(r.removed).toBe(1);
    expect(r.text).not.toContain('[2026-10-24] 心情值');
    expect(r.text).toContain('心情值：547 / 1000');
    expect(r.text).toContain('[2026-10-27] 今天很开心');
  });
});

describe('trimOldestEntries', () => {
  it('未超限时不裁剪', () => {
    const r = trimOldestEntries(SAMPLE, byteLength(SAMPLE) + 100);
    expect(r).toEqual({ text: SAMPLE, removed: 0 });
  });

  it('超限时从最旧日期整组删除（标准分区头部保留）', () => {
    const r = trimOldestEntries(SAMPLE, byteLength(SAMPLE) - 1);
    expect(r.removed).toBe(2); // 2026-10-01 的 2 条
    expect(r.text).not.toContain('2026-10-01');
    expect(r.text).toContain('2026-10-10');
    expect(r.text).toContain('2026-10-20');
    // 新设计：标准分区即使条目被删空也保留头部（方便 AI 后续填充）
    expect(r.text).toContain('## 关于他');
    expect(byteLength(r.text)).toBeLessThanOrEqual(byteLength(SAMPLE) - 1);
  });

  it('★ 受保护区块（他的雷区）超容也不被裁剪', () => {
    const text = [
      '# 长期记忆',
      '',
      '## 他的雷区',
      '',
      '- [2026-01-01] 不要提加班',
      '- [2026-01-02] 不要问体重',
      '',
      '## 近期动态',
      '',
      '- [2026-01-01] 今天很累',
      '- [2026-01-02] 吃了火锅',
    ].join('\n');

    const r = trimOldestEntries(text, 100); // 强制裁剪
    expect(r.text).toContain('不要提加班');   // 雷区保留
    expect(r.text).toContain('不要问体重');
  });

  it('极端阈值下删掉全部条目但保留文件头', () => {
    const r = trimOldestEntries(SAMPLE, 40);
    expect(r.text).toContain('# 长期记忆');
    expect(r.text).not.toMatch(/\[2026-\d{2}-\d{2}\]/);
  });

  it('没有带日期条目时不裁剪', () => {
    const text = '# 长期记忆\n\n## 说明\n随便写点。';
    const r = trimOldestEntries(text, 10);
    expect(r.removed).toBe(0);
  });
});

describe('人物底色（不可变区块）', () => {
  const WITH_IMMUTABLE = `# 长期记忆

> 系统维护

## 人物底色

> 固定设定

- 昵称"小忆"，称用户为"你"。

## 关于他
- [2026-10-01] 旧事实A。
`;

  it('提炼结果不能修改或新增人物底色', () => {
    const distilled = `## 人物底色
- 新的性格设定（不应写入）。
## 关于他
- [2026-10-21] 新事实。`;
    const out = mergeMemoryEntry(WITH_IMMUTABLE, distilled, '2026-10-21');
    expect(out).not.toContain('新的性格设定');
    expect(out).toContain('昵称"小忆"');
    expect(out).toContain('新事实');
  });


  it('裁剪不会删除人物底色', () => {
    const r = trimOldestEntries(WITH_IMMUTABLE, 40);
    expect(r.text).not.toMatch(/\[2026-\d{2}-\d{2}\]/);
    expect(r.text).toContain('## 人物底色');
    expect(r.text).toContain('昵称"小忆"');
  });
});

describe('ensureModuleComments', () => {
  it('为缺失注释的模块补上说明', () => {
    const text = '# 长期记忆\n\n## 关于他\n- [2026-10-01] 事实A。';
    const out = ensureModuleComments(text);
    expect(out).toContain('## 关于他');
    expect(out).toContain('<!-- 他的身份、背景');
    expect(out).toContain('- [2026-10-01] 事实A。');
  });

  it('已有注释时不重复添加（幂等）', () => {
    const once = ensureModuleComments('# 长期记忆\n\n## 关于他\n- [2026-10-01] 事实A。\n');
    expect(ensureModuleComments(once)).toBe(once);
  });

  it('未知模块不加注释', () => {
    const text = '# 长期记忆\n\n## 自定义模块\n随便写点。';
    expect(ensureModuleComments(text)).not.toContain('<!-- 用户的事实');
  });

  it('新分区也会自动补注释', () => {
    const text = '# 长期记忆\n\n## 共同经历\n- [2026-10-01] 一起看过流星雨。';
    const out = ensureModuleComments(text);
    expect(out).toContain('## 共同经历');
    expect(out).toContain('一起看过流星雨');
  });
});

describe('关系变量（好感度/亲密度）', () => {
  const WITH_RELATION = `# 长期记忆

## 称呼与关系

- 用户称呼 AI 为"小忆"。
- 好感度：500 / 1000
- 亲密度：300 / 1000
`;

  it('解析当前值，缺失时用默认值', () => {
    // 5 轴：好感度/亲密度沿用旧默认，信任/尊重/心动缺失时补各自默认值
    const expected = { affinity: 500, intimacy: 300, mood: 500, trust: 600, respect: 650, attraction: 300 };
    expect(parseRelationValues(WITH_RELATION)).toEqual(expected);
    expect(parseRelationValues('# 长期记忆')).toEqual(expected);
  });


  it('C1：AI 提议的数值被忽略（数值由系统计算）', () => {
    const withDrivers = mergeMemoryEntry(WITH_RELATION, '- 好感度：900 / 1000', '2026-10-22', {
      intimacy: {
        userMessages: 20,
        streakDays: 0,
        newMemoryEntries: 0,
        activeDays: 100,
        daysSinceInteraction: 0,
      },
      affinity: {
        warmTurns: 9,
        gratefulCount: 0,
        offensiveCount: 0,
        lowMoodButCompanioned: false,
        hadConflict: false,
        ignoredAllDay: false,
      },
    });
    // 好感度：质量驱动 warmTurns=9 → +3（不取 AI 提议的 900）
    expect(withDrivers).toContain('- 好感度：503 / 1000');
    // 亲密度：20 轮 → 保底 1 + 轮次 2 = +3
    expect(withDrivers).toContain('- 亲密度：303 / 1000');
    expect((withDrivers.match(/好感度[:：]/g) || []).length).toBe(1);
  });

  it('★ 冲突日：好感度下降，亲密度上涨（两者背离）', () => {
    const out = mergeMemoryEntry(WITH_RELATION, '', '2026-10-23', {
      intimacy: {
        userMessages: 30,
        streakDays: 0,
        newMemoryEntries: 0,
        activeDays: 100,
        daysSinceInteraction: 0,
      },
      affinity: {
        warmTurns: 0,
        gratefulCount: 0,
        offensiveCount: 3,
        lowMoodButCompanioned: false,
        hadConflict: true,
        ignoredAllDay: false,
      },
    });
    const aff = out.match(/好感度[:：]\s*(\d+)/);
    const inti = out.match(/亲密度[:：]\s*(\d+)/);
    expect(Number(aff?.[1])).toBeLessThan(500);      // 好感度掉
    expect(Number(inti?.[1])).toBeGreaterThan(300);  // 亲密度涨
  });

  it('★ 亲密度：摩擦不降亲密（天天拌嘴也亲密）', () => {
    const out = mergeMemoryEntry(WITH_RELATION, '', '2026-10-22', {
      intimacy: {
        userMessages: 50,
        streakDays: 10,
        newMemoryEntries: 10,
        activeDays: 200,
        daysSinceInteraction: 0,
      },
      affinity: {
        warmTurns: 0,
        gratefulCount: 0,
        offensiveCount: 2,
        lowMoodButCompanioned: false,
        hadConflict: true,
        ignoredAllDay: false,
      },
    });
    const inti = out.match(/亲密度[:：]\s*(\d+)/);
    expect(Number(inti?.[1])).toBeGreaterThan(300); // 亲密度照样涨
  });

  it('多日连续正面：好感度累积上涨', () => {
    const sig = {
      intimacy: {
        userMessages: 10,
        streakDays: 0,
        newMemoryEntries: 0,
        activeDays: 300,
        daysSinceInteraction: 0,
      },
      affinity: {
        warmTurns: 9,
        gratefulCount: 0,
        offensiveCount: 0,
        lowMoodButCompanioned: false,
        hadConflict: false,
        ignoredAllDay: false,
      },
    };
    let mem = WITH_RELATION;
    for (let i = 0; i < 5; i++) mem = mergeMemoryEntry(mem, '', '2026-10-22', sig);
    const aff = mem.match(/好感度[:：]\s*(\d+)/);
    expect(Number(aff?.[1])).toBeGreaterThan(500); // 累积上涨
  });
});


describe('分层 demoteSectionEntries', () => {
  const big = (n: number) =>
    Array.from(
      { length: n },
      (_, i) => `- [2026-10-${String(i + 1).padStart(2, '0')}] 往事${i + 1}：一起做了什么什么，还挺有意思的。`,
    ).join('\n');

  const build = () => '# 长期记忆\n\n## 人物底色\n- 固定设定。\n\n## 共同经历\n' + big(12) + '\n';

  it('超过目标体积时把最旧的条目搬出去，且不删除', () => {
    const before = build();
    const res = demoteSectionEntries(before, '## 共同经历', 900, 3);
    expect(res.removed.length).toBeGreaterThan(0);
    expect(byteLength(res.text)).toBeLessThan(byteLength(before));
    // 搬出去的每条都是完整条目（可以原样写进档案）
    for (const line of res.removed) expect(line).toMatch(/^- \[\d{4}-\d{2}-\d{2}\]/);
    // 至少保留 keepAtLeast 条
    expect(res.text.match(/^- \[/gm)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });

  it('未超目标时不动', () => {
    const before = '# 长期记忆\n\n## 共同经历\n- [2026-10-01] 一条。\n';
    const res = demoteSectionEntries(before, '## 共同经历', 900, 3);
    expect(res.removed).toEqual([]);
    expect(res.text).toBe(before);
  });

  it('受保护分区不参与分层', () => {
    const before = build().replace('## 共同经历', '## 他的雷区');
    const res = demoteSectionEntries(before, '## 他的雷区', 100, 3);
    expect(res.removed).toEqual([]);
  });
});

describe('记忆密度整理 compactMemoryEntries', () => {
  it('关于他同内容跨日期去重，保留信息更长的正文与最早日期', () => {
    const before = `# 长期记忆

## 关于他
- [26-10-01] 用户是 C 开发者
- [26-10-20] 用户是 C 开发者，做跨端聊天软件

## 他的雷区
- 不要提加班
- 不要提加班
`;
    const out = compactMemoryEntries(before);
    expect(out.removed).toBe(1);
    expect(out.text).toContain('用户是 C 开发者，做跨端聊天软件');
    expect(out.text).not.toContain('用户是 C 开发者\n');
    // 受保护分区不动
    expect(out.text.match(/不要提加班/g)).toHaveLength(2);
  });

  it('关于他的键=值取最新值，不被旧的长句覆盖', () => {
    const before = `# 长期记忆\n\n## 关于他\n- [26-10-01] 职业=C 开发者，做 epoll/timerfd 很久了\n- [26-10-20] 职业=Go\n`;
    const out = compactMemoryEntries(before);
    expect(out.text).toContain('职业=Go');
    expect(out.text).not.toContain('职业=C 开发者');
  });

  it('事件分区只合并同一天同内容，不误删不同日期的同一件事', () => {
    const before = `# 长期记忆

## 共同经历
- [26-10-01] 一起吃饭
- [26-10-01] 一起吃饭
- [26-10-02] 一起吃饭
`;
    const out = compactMemoryEntries(before);
    expect(out.removed).toBe(1);
    expect(out.text.match(/\[26-10-01\] 一起吃饭/g)).toHaveLength(1);
    expect(out.text).toContain('[26-10-02] 一起吃饭');
  });

  it('没有重复时原样返回', () => {
    const before = '# 长期记忆\n\n## 关于他\n- [26-10-01] 唯一事实\n';
    const out = compactMemoryEntries(before);
    expect(out.removed).toBe(0);
    expect(out.text).toBe(before);
  });

  it('memoryDensity 统计条目数与平均字节', () => {
    const d = memoryDensity('# x\n- [26-10-01] a\n- [26-10-02] bb\n');
    expect(d.entries).toBe(2);
    expect(d.bytes).toBeGreaterThan(0);
    expect(d.bytesPerEntry).toBeGreaterThan(0);
  });
});

describe('键=值 覆盖式更新', () => {
  it('同键的旧条目被原地替换，不会叠加', () => {
    const before = `# 长期记忆

## 他的偏好
- [2026-10-01] 作息=爱熬夜
- [2026-10-01] 颜色=绿
`;
    const distilled = `## 他的偏好
- [2026-10-22] 作息=恨熬夜但天天熬
`;
    const after = mergeMemoryEntry(before, distilled);

    expect(after).toContain('作息=恨熬夜但天天熬');
    expect(after).not.toContain('作息=爱熬夜');
    expect(after.match(/作息=/g)?.length).toBe(1);
    expect(after).toContain('颜色=绿'); // 其它键不受影响
  });

  it('新键直接追加', () => {
    const before = `# 长期记忆

## 他的偏好
- [2026-10-01] 颜色=绿
`;
    const after = mergeMemoryEntry(before, `## 他的偏好\n- [2026-10-22] 聊天长度=偏好短消息\n`);
    expect(after).toContain('颜色=绿');
    expect(after).toContain('聊天长度=偏好短消息');
  });

  it('散文里的全角冒号不当作键（不会被误覆盖）', () => {
    const before = `# 长期记忆

## 他的偏好
- [2026-10-01] 沟通：喜欢短句
`;
    const after = mergeMemoryEntry(before, `## 他的偏好\n- [2026-10-22] 沟通：喜欢长文\n`);
    expect(after).toContain('沟通：喜欢短句');
    expect(after).toContain('沟通：喜欢长文');
  });

  it('兼容短日期 YY-MM-DD，并保留新条目短格式', () => {
    const before = `# 长期记忆

## 关于他
- [26-10-20] 旧事实
`;
    const after = mergeMemoryEntry(before, `## 关于他\n- [26-10-23] 新事实\n`, '2026-10-23');
    expect(after).toContain('- [26-10-20] 旧事实');
    expect(after).toContain('- [26-10-23] 新事实');
  });
});

describe('splitMemoryForPrompt（缓存分段）', () => {
  const MEM = `# 长期记忆

## 人物底色
- 名字=大肥鱼；自称=本小姐。

## 称呼与关系
- 平时叫用户“大笨蛋”。

## 关于他
- [26-10-20] 城=杭州。

## 他的偏好
- [26-10-20] 喜=喝奶茶。

## 进行中的事
- [26-10-30] 正在重构记忆系统。

## 近期动态
- [26-10-30] 今天加班到十点。

## 他的雷区
- 不要提跳槽。`;

  it('小时内会变的分区进 volatile，其余进 stable', () => {
    const { stable, volatile } = splitMemoryForPrompt(MEM);
    expect(stable).toContain('## 人物底色');
    expect(stable).toContain('## 称呼与关系');
    expect(stable).toContain('## 他的雷区');
    expect(stable).not.toContain('## 进行中的事');
    expect(stable).not.toContain('## 近期动态');
    expect(volatile).toContain('## 进行中的事');
    expect(volatile).toContain('## 近期动态');
    expect(volatile).not.toContain('## 人物底色');
  });

  it('未识别的分区默认留在 stable（宁可缓存吃亏也不丢内容）', () => {
    const { stable } = splitMemoryForPrompt(`${MEM}\n\n## 某个新分区\n- 新东西`);
    expect(stable).toContain('## 某个新分区');
    expect(stable).toContain('新东西');
  });

  it('两段拼起来不丢任何分区', () => {
    const { stable, volatile } = splitMemoryForPrompt(MEM);
    const both = stable + '\n' + volatile;
    for (const h of ['人物底色', '称呼与关系', '关于他', '他的偏好', '进行中的事', '近期动态', '他的雷区']) {
      expect(both).toContain(`## ${h}`);
    }
  });

  it('近期动态改一个字，stable 段字节完全不变', () => {
    const a = splitMemoryForPrompt(MEM);
    const b = splitMemoryForPrompt(MEM.replace('加班到十点', '加班到十一点'));
    expect(b.stable).toBe(a.stable);
    expect(b.volatile).not.toBe(a.volatile);
  });

  it('空字符串不炸', () => {
    const { stable, volatile } = splitMemoryForPrompt('');
    expect(stable).toBe('');
    expect(volatile).toBe('');
  });
});

describe('demoteSectionToBudget', () => {
  const doc = [
    '# 长期记忆',
    '## 共同经历',
    '- [26-10-01] 第一件事 xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    '- [26-10-02] 第二件事 xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    '- [26-10-03] 第三件事 xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    '- [26-10-04] 第四件事 xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    '## 他的雷区',
    '- [26-10-01] 别提体重',
  ].join('\n');

  it('超预算时只搬最旧的几条，且不动受保护分区', () => {
    const r = demoteSectionToBudget(doc, '## 共同经历', 200, 2);
    expect(r.removed.length).toBeGreaterThan(0);
    expect(r.text).toContain('第四件事');
    expect(r.text).toContain('别提体重');
  });

  it('未超预算时原样返回', () => {
    const r = demoteSectionToBudget(doc, '## 共同经历', 100000);
    expect(r.removed).toEqual([]);
    expect(r.text).toBe(doc);
  });

  it('受保护分区不参与', () => {
    const r = demoteSectionToBudget(doc, '## 他的雷区', 1);
    expect(r.removed).toEqual([]);
  });
});
