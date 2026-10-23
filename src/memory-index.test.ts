import { describe, expect, it } from 'vitest';
import { extractCoreMemory, parseMemoryEntries } from './memory-index';

const SAMPLE = `# 长期记忆

## 人物底色
- 名字=大肥鱼

## 称呼与关系
- 用户叫AI=大肥鱼
- 好感度：680 / 1000

## 关于用户
- [26-10-21] 深圳；上班8:15
- [26-10-21] 职业=C开发

## 近期动态
- [26-10-24] 赛博搬家进行中
`;

describe('extractCoreMemory', () => {
  it('只保留三个常驻核心分区', () => {
    const core = extractCoreMemory(SAMPLE);
    expect(core).toContain('## 人物底色');
    expect(core).toContain('## 称呼与关系');
    expect(core).not.toContain('## 关于用户');
    expect(core).not.toContain('## 近期动态');
  });
});

describe('parseMemoryEntries', () => {
  it('非核心分区的条目进索引，关系数值行跳过', () => {
    const entries = parseMemoryEntries(SAMPLE, 'memory');
    const contents = entries.map((e) => e.content);
    expect(contents).toContain('深圳；上班8:15');
    expect(contents).toContain('职业=C开发');
    expect(contents).toContain('赛博搬家进行中');
    expect(contents).not.toContain('名字=大肥鱼'); // 核心分区不进索引
    expect(entries.some((e) => e.content.includes('好感度'))).toBe(false);
    expect(entries.every((e) => e.section)).toBe(true);
  });
});
