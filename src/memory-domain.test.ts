import { describe, expect, it } from 'vitest';
import {
  buildMemoryChunks,
  canonicalizeFacts,
  factId,
  formatMemoryChunks,
  isFactActive,
  parseArchiveContext,
  parseMemoryContext,
  projectMemoryContext,
  rankMemoryChunks,
  stableHash,
  type MemoryFact,
} from './memory-domain';

const SAMPLE = `# 长期记忆

## 人物底色
- 名字=阿澈；自称=我

## 称呼与关系
- 用户叫AI=阿澈
- 好感度：620 / 1000

## 关于他
- [26-10-01] 城市=杭州
- [26-10-01] 职业=后端开发
- [26-10-02] 猫=团子

## 他的偏好
- [26-10-03] 颜色=蓝

## 进行中的事
- [26-10-10] [进行中] 项目=星海（个人记忆系统）

## 共同经历
- [26-10-01] 第一次聊天聊到凌晨

## 他的雷区
- 不要拿它和别的 AI 比较

## 近期动态
- [26-10-20] 在整理记忆架构
`;

describe('memory-domain 解析', () => {
  it('核心分区不进 facts/events，关系行跳过', () => {
    const parsed = parseMemoryContext(SAMPLE);
    expect(parsed.facts.some((f) => f.content.includes('好感度'))).toBe(false);
    expect(parsed.facts.some((f) => f.content.includes('名字=阿澈'))).toBe(false);
    expect(parsed.facts.length).toBe(5); // 关于他 3 + 偏好 1 + 事项 1；雷区是核心，跳过
    expect(parsed.events.map((e) => e.summary)).toContain('在整理记忆架构');
  });

  it('键=值 被解析为 subject/predicate/object', () => {
    const parsed = parseMemoryContext(SAMPLE);
    const city = parsed.facts.find((f) => f.content.includes('城市=杭州'));
    expect(city?.predicate).toBe('城市');
    expect(city?.object).toBe('杭州');
  });

  it('id 稳定可复现', () => {
    expect(factId('关于他', '2026-10-01', '城市=杭州')).toBe(
      factId('关于他', '2026-10-01', '城市=杭州'),
    );
    expect(stableHash('abc')).toHaveLength(8);
  });

  it('无日期条目也进入 facts，不再被 next 静默丢弃', () => {
    const parsed = parseMemoryContext('## 关于他\n- 城市=杭州');
    expect(parsed.facts).toHaveLength(1);
    expect(parsed.facts[0].content).toBe('城市=杭州');
    expect(parsed.facts[0].validFrom).toBeNull();
  });
});

describe('memory-domain archive 导入', () => {
  it('把档案行解析为事件，不进入投影', () => {
    const events = parseArchiveContext([
      '- [24-10-01] 旧事一 #日常',
      '- [2026-10-02] 旧事二',
      '- 没有日期的行',
    ]);
    expect(events).toHaveLength(2);
    expect(events[0].section).toBe('档案');
    expect(events[0].dateKey).toBe('2024-10-01');
    const chunks = buildMemoryChunks({ facts: [], events });
    expect(chunks).toHaveLength(2);
    expect(chunks[0].importance).toBe(1);
  });
});

describe('memory-domain 投影', () => {
  it('保留 pinned 核心区，重建其它分区', () => {
    const parsed = parseMemoryContext(SAMPLE);
    const out = projectMemoryContext(SAMPLE, parsed);
    expect(out).toContain('## 人物底色');
    expect(out).toContain('- 名字=阿澈；自称=我');
    expect(out).toContain('## 关于他');
    expect(out).toContain('- [26-10-01] 城市=杭州');
    expect(out).toContain('## 共同经历');
    expect(out).toContain('- [26-10-01] 第一次聊天聊到凌晨');
    expect(out).toContain('## 近期动态');
    expect(out).toContain('好感度：620');
  });

  it('他的更正分区进入投影，不被丢弃', () => {
    const text = `# 长期记忆\n\n## 他的更正（最高优先级）\n- [26-10-28] 我喜欢被叫大人\n\n## 关于他\n- [26-10-01] 城市=杭州\n`;
    const parsed = parseMemoryContext(text);
    const out = projectMemoryContext(text, parsed);
    expect(out).toContain('## 他的更正（最高优先级）');
    expect(out).toContain('我喜欢被叫大人');
  });
});

function fact(overrides: Partial<MemoryFact> = {}): MemoryFact {
  return {
    id: factId('关于他', '2026-10-01', '城市=杭州'),
    section: '关于他',
    content: '城市=杭州',
    subject: '城市',
    predicate: '城市',
    object: '杭州',
    validFrom: '2026-10-01',
    validTo: null,
    confidence: 1,
    sourceMessageIds: [],
    tags: [],
    contentHash: stableHash('城市=杭州'),
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('memory-domain 有效期/冲突', () => {
  it('valid_to 之后失效', () => {
    expect(isFactActive(fact(), '2026-10-24')).toBe(true);
    expect(isFactActive(fact({ validTo: '2026-10-20' }), '2026-10-24')).toBe(false);
    expect(isFactActive(fact({ validFrom: '2026-10-25' }), '2026-10-24')).toBe(false);
  });

  it('同一 predicate 保留较新事实并合并来源', () => {
    const old = fact({ validFrom: '2026-10-01', sourceMessageIds: [1] });
    const newer = fact({
      id: factId('关于他', '2026-10-20', '城市=上海'),
      content: '城市=上海',
      object: '上海',
      validFrom: '2026-10-20',
      contentHash: stableHash('城市=上海'),
      sourceMessageIds: [2],
    });
    const out = canonicalizeFacts([old, newer], '2026-10-24');
    expect(out).toHaveLength(1);
    expect(out[0].object).toBe('上海');
    expect(out[0].sourceMessageIds).toEqual([1, 2]);
  });

  it('过期事实不进入 canonical 集合', () => {
    const out = canonicalizeFacts([fact({ validTo: '2026-10-01' })], '2026-10-24');
    expect(out).toHaveLength(0);
  });
});

describe('memory-domain 排序', () => {
  const chunks = buildMemoryChunks(parseMemoryContext(SAMPLE));

  it('命中关键词/同义词时召回对应条目', () => {
    const city = rankMemoryChunks('我住在哪个城市', chunks, 3);
    expect(city.some((c) => c.content.includes('城市=杭州'))).toBe(true);

    const late = rankMemoryChunks('昨晚又熬夜了', chunks, 3);
    expect(late.some((c) => c.content.includes('凌晨'))).toBe(true);
  });

  it('无命中返回空', () => {
    expect(rankMemoryChunks('今天吃什么', chunks, 3)).toEqual([]);
  });

  it('格式化带日期与来源块', () => {
    const picked = rankMemoryChunks('城市', chunks, 1);
    const text = formatMemoryChunks(picked);
    expect(text).toContain('## 相关记忆（Memory Context）');
    expect(text).toContain('[2026-10-01]');
    expect(text).toContain('城市=杭州');
  });
});
