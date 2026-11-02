import { describe, expect, it } from 'vitest';
import { loadLifeBlocks } from './chat-blocks';

const bare = {} as never;

describe('聊天提示词的生活块', () => {
  it('读不到日程时：名录照给，生活块为空', async () => {
    const b = await loadLifeBlocks(bare, new Date('2026-11-02T09:00:00+08:00'));
    expect(b.residents).toContain('AI 中继站公寓');
    expect(b.life).toBeNull();
  });

  it('两个入口拿到的是同一个来源（不会一边有一边没有）', async () => {
    const a = await loadLifeBlocks(bare, new Date('2026-11-02T09:00:00+08:00'));
    const z = await loadLifeBlocks(bare, new Date('2026-11-02T09:00:00+08:00'));
    expect(a.residents).toBe(z.residents);
  });
});
