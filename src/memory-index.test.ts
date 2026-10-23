import { describe, expect, it } from 'vitest';
import { decodeVec, extractCoreMemory, parseMemoryEntries, quantizeVec } from './memory-index';

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

describe('向量 int8 量化', () => {
  it('量化→解码往返误差受控，且兼容旧 float 数组', () => {
    const orig = [0.5, -0.25, 0.9, -0.9, 0.1];
    const q = quantizeVec(orig);
    expect(q).toBeTruthy();
    const dec = decodeVec(q!);
    expect(dec).toHaveLength(orig.length);
    if (dec) {
      const range = Math.max(...orig) - Math.min(...orig);
      dec.forEach((v, i) => expect(Math.abs(v - orig[i])).toBeLessThanOrEqual(range / 255 + 1e-9));
    }
    // 旧格式（float 数组 JSON）仍然可解码
    expect(decodeVec(JSON.stringify(orig))).toEqual(orig);
    expect(decodeVec(null)).toBeNull();
  });
});
