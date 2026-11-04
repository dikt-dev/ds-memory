import { describe, expect, it } from 'vitest';
import { loadLifeBlocks } from './chat-blocks';

const bare = {} as never;

describe('聊天提示词的生活块', () => {
  it('人设文档没写「人际关系」时：不塞任何名字和长相', async () => {
    const b = await loadLifeBlocks(bare, new Date('2026-11-02T09:00:00+08:00'));
    expect(b.residents).toBeNull();
    expect(b.life).toBeNull();
  });

  it('两个入口拿到的是同一个来源（不会一边有一边没有）', async () => {
    const a = await loadLifeBlocks(bare, new Date('2026-11-02T09:00:00+08:00'));
    const z = await loadLifeBlocks(bare, new Date('2026-11-02T09:00:00+08:00'));
    expect(a.residents).toBe(z.residents);
  });
});
