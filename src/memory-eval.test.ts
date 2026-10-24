import { describe, expect, it } from 'vitest';
import fixture from '../docs/eval/fixture-memory.md?raw';
import goldenRaw from '../docs/eval/golden-memory.json?raw';
import { buildMemoryChunks, parseMemoryContext, rankMemoryChunks } from './memory-domain';

interface GoldenCase {
  id: string;
  query: string;
  expected_any: string[];
  expect_no_recall?: boolean;
  section: string;
}

const golden = JSON.parse(goldenRaw) as { cases: GoldenCase[] };
/** 核心区永远走 pinned 注入，不参与 chunk 召回评测。 */
const CORE = new Set(['人物底色', '称呼与关系', '雷区与禁忌']);
const cases = golden.cases.filter((c) => !CORE.has(c.section));
const chunks = buildMemoryChunks(parseMemoryContext(fixture));

describe('Memory Context golden set（合成夹具）', () => {
  it('核心区不参与召回，避免和 pinned 重复评测', () => {
    expect(cases.length).toBeLessThan(golden.cases.length);
    expect(cases.length).toBeGreaterThanOrEqual(17);
  });

  it('recall@6 达到 Phase 2 基线', () => {
    const hits: string[] = [];
    const misses: string[] = [];
    for (const c of cases) {
      if (c.expect_no_recall) continue;
      const picked = rankMemoryChunks(c.query, chunks, 6);
      const joined = picked.map((p) => p.content).join('\n');
      if (c.expected_any.some((x) => joined.includes(x))) hits.push(c.id);
      else misses.push(`${c.id}: ${c.query}`);
    }
    const recall = hits.length / Math.max(1, hits.length + misses.length);
    // 基线先定 0.85；低于它说明解析/排序退化，而不是“差不多”。
    // 合成夹具当前为 1.0（16 条非核心 query），真实数据基线在 Phase 4 补。
    expect(recall, `misses:\n${misses.join('\n')}`).toBeGreaterThanOrEqual(0.85);
  });

  it('negative case 不强行召回私人事实', () => {
    const negatives = cases.filter((c) => c.expect_no_recall);
    expect(negatives.length).toBeGreaterThanOrEqual(2);
    for (const c of negatives) {
      const picked = rankMemoryChunks(c.query, chunks, 6);
      expect(picked, `${c.id} should not recall: ${picked.map((p) => p.content).join(' | ')}`).toHaveLength(0);
    }
  });
});
