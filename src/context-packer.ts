/**
 * Context Packer（Phase 4）：召回结果的字节预算、去重与稳定顺序。
 *
 * 当前只包召回层；core/10 轮/memo 仍由 prompt 组装。
 * 超预算时优先保留高排名条目，整条丢弃而不是截断句子。
 */
import type { MemoryChunk } from './memory-domain';

export const RECALL_BUDGET_BYTES = 2400;

export interface PackedMemory {
  chunks: MemoryChunk[];
  bytes: number;
  dropped: number;
}

export function byteSize(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function packMemoryChunks(
  chunks: MemoryChunk[],
  maxBytes = RECALL_BUDGET_BYTES,
): PackedMemory {
  const seen = new Set<string>();
  const kept: MemoryChunk[] = [];
  let bytes = 0;
  let dropped = 0;
  for (const chunk of chunks) {
    const key = chunk.contentHash || chunk.content;
    if (seen.has(key)) {
      dropped += 1;
      continue;
    }
    const size = byteSize(`- ${chunk.date ? `[${chunk.date}] ` : ''}${chunk.content}`) + 1;
    if (bytes + size > maxBytes) {
      dropped += 1;
      continue;
    }
    seen.add(key);
    kept.push(chunk);
    bytes += size;
  }
  return { chunks: kept, bytes, dropped };
}
