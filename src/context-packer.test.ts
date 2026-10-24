import { describe, expect, it } from 'vitest';
import { packMemoryChunks } from './context-packer';
import type { MemoryChunk } from './memory-domain';

function chunk(content: string, hash = content): MemoryChunk {
  return {
    id: `c-${hash}`,
    source: 'fact',
    sourceId: `f-${hash}`,
    section: '关于用户',
    content,
    date: '2026-10-01',
    keywords: [],
    tags: [],
    importance: 2,
    contentHash: hash,
    updatedAt: 1,
  };
}

describe('packMemoryChunks', () => {
  it('按预算保留高排名条目', () => {
    const packed = packMemoryChunks([chunk('a'.repeat(100)), chunk('b'.repeat(100))], 130);
    expect(packed.chunks).toHaveLength(1);
    expect(packed.bytes).toBeLessThanOrEqual(130);
    expect(packed.dropped).toBe(1);
  });

  it('按 contentHash 去重', () => {
    const packed = packMemoryChunks([chunk('城市=杭州', 'same'), chunk('城市=杭州', 'same')], 1000);
    expect(packed.chunks).toHaveLength(1);
    expect(packed.dropped).toBe(1);
  });

  it('单条超预算不截断，整条丢弃', () => {
    const packed = packMemoryChunks([chunk('x'.repeat(500))], 20);
    expect(packed.chunks).toHaveLength(0);
    expect(packed.dropped).toBe(1);
  });
});
