import { describe, expect, it } from 'vitest';
import {
  applyRelationDelta,
  byteLength,
  demoteSectionEntries,
  enforceSectionBudgets,
  ensureModuleComments,
  extractImmutableSection,
  injectImmutableSection,
  mergeMemoryEntry,
  parseRelationValues,
  reportSectionBudgets,
  trimOldestEntries,
} from './memory-maintenance';

const SAMPLE = `# 长期记忆

> 系统维护

## 关于用户
- [2026-10-01] 旧事实A。
- [2026-10-01] 旧事实B。

## 偏好与习惯
- [2026-10-10] 偏好C。

## 进行中的事项
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
    const distilled = `## 关于用户
- [2026-10-01] 旧事实A。`;
    const out = mergeMemoryEntry(SAMPLE, distilled, '2026-10-21');
    expect(out).toBe(SAMPLE); // 无变化
  });

  it('新条目合并进已有分类，缺日期时补 fallback 日期', () => {
    const distilled = `## 偏好与习惯
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
    expect(out.indexOf('## 关于用户')).toBeLessThan(out.indexOf('## 全新分类'));
  });

  it('提炼结果无有效条目时原样返回', () => {
    expect(mergeMemoryEntry(SAMPLE, '今天没什么可记的。', '2026-10-21')).toBe(SAMPLE);
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
    expect(r.text).toContain('## 关于用户');
    expect(byteLength(r.text)).toBeLessThanOrEqual(byteLength(SAMPLE) - 1);
  });

  it('★ 受保护区块（雷区与禁忌）超容也不被裁剪', () => {
    const text = [
      '# 长期记忆',
      '',
      '## 雷区与禁忌',
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

## 关于用户
- [2026-10-01] 旧事实A。
`;

  it('提炼结果不能修改或新增人物底色', () => {
    const distilled = `## 人物底色
- 新的性格设定（不应写入）。
## 关于用户
- [2026-10-21] 新事实。`;
    const out = mergeMemoryEntry(WITH_IMMUTABLE, distilled, '2026-10-21');
    expect(out).not.toContain('新的性格设定');
    expect(out).toContain('昵称"小忆"');
    expect(out).toContain('新事实');
  });

  it('压缩时先取出、压缩后原样放回', () => {
    const { body, section } = extractImmutableSection(WITH_IMMUTABLE);
    expect(section).toContain('昵称"小忆"');
    expect(body).not.toContain('人物底色');
    const restored = injectImmutableSection(body, section!);
    expect(restored).toContain('## 人物底色');
    expect(restored).toContain('昵称"小忆"');
    expect(restored).toContain('旧事实A');
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
    const text = '# 长期记忆\n\n## 关于用户\n- [2026-10-01] 事实A。';
    const out = ensureModuleComments(text);
    expect(out).toContain('## 关于用户');
    expect(out).toContain('<!-- 身份、背景');
    expect(out).toContain('- [2026-10-01] 事实A。');
  });

  it('已有注释时不重复添加（幂等）', () => {
    const once = ensureModuleComments('# 长期记忆\n\n## 关于用户\n- [2026-10-01] 事实A。\n');
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

  it('applyRelationDelta：单日 ±5 截断与 0~1000 边界', () => {
    expect(applyRelationDelta(500, 900)).toBe(505);
    expect(applyRelationDelta(500, 100)).toBe(495);
    expect(applyRelationDelta(0, 3)).toBe(3);
    expect(applyRelationDelta(0, -10)).toBe(0);
    expect(applyRelationDelta(1000, 1200)).toBe(1000);
    expect(applyRelationDelta(998, 1000)).toBe(1000);
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

describe('分区配额 enforceSectionBudgets', () => {
  const big = (n: number) =>
    Array.from(
      { length: n },
      (_, i) => `- [2026-10-0${(i % 9) + 1}] 事件${i + 1}：一起把第 ${i + 1} 个模块调通了，还挺有成就感的。`,
    ).join('\n');

  const build = () => `# 长期记忆

## 人物底色
- 这是固定设定，一个字都不能动。

## 偏好与习惯
${big(40)}
`;

  it('超预算的分区把最旧两条合并，字节下降但内容不丢', () => {
    const before = build();
    const res = enforceSectionBudgets(before);

    expect(res.changed).toBe(true);
    expect(res.merged).toBeGreaterThan(0);
    expect(byteLength(res.text)).toBeLessThan(byteLength(before));

    // 每一条的内容都还在（只是合并掉了重复的日期前缀）
    for (let i = 1; i <= 40; i++) {
      expect(res.text).toContain(`事件${i}：`);
    }
  });

  it('受保护分区一行都不动', () => {
    const before = build();
    const res = enforceSectionBudgets(before);
    expect(res.text).toContain('- 这是固定设定，一个字都不能动。');
  });

  it('没超预算时原样返回', () => {
    const small = '# 长期记忆\n\n## 共同经历\n- [2026-10-01] 小事一桩。\n';
    const res = enforceSectionBudgets(small);
    expect(res.changed).toBe(false);
    expect(res.text).toBe(small);
  });

  it('reportSectionBudgets 能报出超预算的分区', () => {
    const report = reportSectionBudgets(build());
    const shared = report.find((r) => r.header === '## 偏好与习惯');
    expect(shared?.over).toBe(true);
    expect(shared?.bytes).toBeGreaterThan(shared?.budget ?? 0);
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
    const before = build().replace('## 共同经历', '## 雷区与禁忌');
    const res = demoteSectionEntries(before, '## 雷区与禁忌', 100, 3);
    expect(res.removed).toEqual([]);
  });
});

describe('键=值 覆盖式更新', () => {
  it('同键的旧条目被原地替换，不会叠加', () => {
    const before = `# 长期记忆

## 偏好与习惯
- [2026-10-01] 作息=爱熬夜
- [2026-10-01] 颜色=绿
`;
    const distilled = `## 偏好与习惯
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

## 偏好与习惯
- [2026-10-01] 颜色=绿
`;
    const after = mergeMemoryEntry(before, `## 偏好与习惯\n- [2026-10-22] 聊天长度=偏好短消息\n`);
    expect(after).toContain('颜色=绿');
    expect(after).toContain('聊天长度=偏好短消息');
  });

  it('散文里的全角冒号不当作键（不会被误覆盖）', () => {
    const before = `# 长期记忆

## 偏好与习惯
- [2026-10-01] 沟通：喜欢短句
`;
    const after = mergeMemoryEntry(before, `## 偏好与习惯\n- [2026-10-22] 沟通：喜欢长文\n`);
    expect(after).toContain('沟通：喜欢短句');
    expect(after).toContain('沟通：喜欢长文');
  });

  it('兼容短日期 YY-MM-DD，并保留新条目短格式', () => {
    const before = `# 长期记忆

## 关于用户
- [26-10-20] 旧事实
`;
    const after = mergeMemoryEntry(before, `## 关于用户\n- [26-10-23] 新事实\n`, '2026-10-23');
    expect(after).toContain('- [26-10-20] 旧事实');
    expect(after).toContain('- [26-10-23] 新事实');
  });
});
