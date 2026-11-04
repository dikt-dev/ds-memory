import { describe, expect, it } from 'vitest';
import {
  buildMemoryChunks,
  mmrSelectChunks,
  parseMemoryContext,
  rankMemoryChunks,
  type MemoryChunk,
} from './memory-domain';
import { quantizeVec } from './memory-index';

const text = `# 长期记忆

## 关于他
- [26-10-01] 城市=杭州
- [26-10-02] 猫=团子

## 他的偏好
- [26-10-03] 颜色=蓝
`;

function withVec(chunks: MemoryChunk[], vecs: Record<string, number[]>): MemoryChunk[] {
  return chunks.map((c) => {
    const v = vecs[c.content];
    return v ? { ...c, vec: quantizeVec(v) } : c;
  });
}

describe('hybrid / RRF / MMR', () => {
  it('向量能召回关键词没命中的条目', () => {
    const chunks = withVec(buildMemoryChunks(parseMemoryContext(text)), {
      '城市=杭州': [1, 0, 0],
      '猫=团子': [0, 1, 0],
      '颜色=蓝': [0, 0, 1],
    });
    const picked = rankMemoryChunks('我住在哪', chunks, 3, '', { queryVec: [1, 0, 0] });
    expect(picked[0].content).toBe('城市=杭州');
  });

  it('MMR 会优先选择不重复的条目', () => {
    const base = buildMemoryChunks(parseMemoryContext(text));
    const a = { ...base[0], vec: quantizeVec([1, 0]) };
    const b = { ...base[1], vec: quantizeVec([0.99, 0.01]) };
    const c = { ...base[2], vec: quantizeVec([0, 1]) };
    const selected = mmrSelectChunks(
      [
        { chunk: a, score: 10 },
        { chunk: b, score: 9.9 },
        { chunk: c, score: 8 },
      ],
      2,
      0.5,
    );
    expect(selected.map((x) => x.content)).toContain('颜色=蓝');
  });

  it('没有向量时自动退回关键词', () => {
    const chunks = buildMemoryChunks(parseMemoryContext(text));
    const picked = rankMemoryChunks('颜色', chunks, 3, '', { queryVec: [1, 0] });
    expect(picked.some((c) => c.content.includes('颜色=蓝'))).toBe(true);
  });
});
