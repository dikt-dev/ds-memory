import { describe, expect, it } from 'vitest';
import {
  buildMemoryChunks,
  factId,
  formatMemoryChunks,
  parseMemoryContext,
  projectMemoryContext,
  rankMemoryChunks,
  stableHash,
} from './memory-domain';

const SAMPLE = `# 长期记忆

## 人物底色
- 名字=阿澈；自称=我

## 称呼与关系
- 用户叫AI=阿澈
- 好感度：620 / 1000

## 关于用户
- [26-10-01] 城市=杭州
- [26-10-01] 职业=后端开发
- [26-10-02] 猫=团子

## 偏好与习惯
- [26-10-03] 颜色=蓝

## 进行中的事项
- [26-10-10] [进行中] 项目=星海（个人记忆系统）

## 共同经历
- [26-10-01] 第一次聊天聊到凌晨

## 雷区与禁忌
- 不要拿它和别的 AI 比较

## 近期动态
- [26-10-20] 在整理记忆架构
`;

describe('memory-domain 解析', () => {
  it('核心分区不进 facts/events，关系行跳过', () => {
    const parsed = parseMemoryContext(SAMPLE);
    expect(parsed.facts.some((f) => f.content.includes('好感度'))).toBe(false);
    expect(parsed.facts.some((f) => f.content.includes('名字=阿澈'))).toBe(false);
    expect(parsed.facts.length).toBe(5); // 关于用户 3 + 偏好 1 + 事项 1；雷区是核心，跳过
    expect(parsed.events.map((e) => e.summary)).toContain('在整理记忆架构');
  });

  it('键=值 被解析为 subject/predicate/object', () => {
    const parsed = parseMemoryContext(SAMPLE);
    const city = parsed.facts.find((f) => f.content.includes('城市=杭州'));
    expect(city?.predicate).toBe('城市');
    expect(city?.object).toBe('杭州');
  });

  it('id 稳定可复现', () => {
    expect(factId('关于用户', '2026-10-01', '城市=杭州')).toBe(
      factId('关于用户', '2026-10-01', '城市=杭州'),
    );
    expect(stableHash('abc')).toHaveLength(8);
  });
});

describe('memory-domain 投影', () => {
  it('保留 pinned 核心区，重建其它分区', () => {
    const parsed = parseMemoryContext(SAMPLE);
    const out = projectMemoryContext(SAMPLE, parsed);
    expect(out).toContain('## 人物底色');
    expect(out).toContain('- 名字=阿澈；自称=我');
    expect(out).toContain('## 关于用户');
    expect(out).toContain('- [26-10-01] 城市=杭州');
    expect(out).toContain('## 共同经历');
    expect(out).toContain('- [26-10-01] 第一次聊天聊到凌晨');
    expect(out).toContain('## 近期动态');
    expect(out).toContain('好感度：620');
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
