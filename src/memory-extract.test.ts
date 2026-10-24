import { describe, expect, it } from 'vitest';
import { extractFactsFromMessages } from './memory-extract';

describe('extractFactsFromMessages', () => {
  it('抽取显式自述并带来源/日期', () => {
    const facts = extractFactsFromMessages([
      { id: 10, role: 'user', content: '我住在杭州，我的猫叫团子', dateKey: '2026-10-24' },
      { id: 11, role: 'user', content: '我喜欢蓝色，我讨厌被比较', dateKey: '2026-10-24' },
      { id: 12, role: 'assistant', content: '我住在模型里', dateKey: '2026-10-24' },
    ]);
    expect(facts).toHaveLength(4);
    expect(facts.every((f) => f.sourceMessageIds.length === 1)).toBe(true);
    expect(facts.find((f) => f.content === '城市=杭州')?.sourceMessageIds).toEqual([10]);
    expect(facts.find((f) => f.content === '宠物=团子')?.section).toBe('关于用户');
    expect(facts.find((f) => f.content === '讨厌=被比较')?.section).toBe('雷区与禁忌');
  });

  it('同一条消息的同槽位只保留一条', () => {
    const facts = extractFactsFromMessages([
      { id: 1, role: 'user', content: '我喜欢蓝色，也喜欢绿色', dateKey: '2026-10-24' },
    ]);
    expect(facts.filter((f) => f.predicate === '喜欢')).toHaveLength(1);
  });

  it('技术请求/无自述不产生事实', () => {
    expect(
      extractFactsFromMessages([
        { id: 2, role: 'user', content: '帮我写一段快速排序', dateKey: '2026-10-24' },
      ]),
    ).toHaveLength(0);
  });
});
