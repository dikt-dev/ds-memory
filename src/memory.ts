/**
 * 长期记忆读写：R2 memory.md 为源，KV 为 24h 缓存。
 * - 读：KV 命中直接用；miss 回源 R2 并写回（缓存失效后自动重建）。
 * - 写（每日提炼任务）：先删旧缓存再同时更新 R2 与 KV —— 即使旧缓存未过期也强制失效。
 * - 任何存储异常都降级：聊天继续，只是暂时不带记忆，绝不因此 500。
 */
import type { Env } from './types';
import { getObject, putObject } from './storage';

export const MEMORY_R2_KEY = 'memory.md';
export const MEMORY_KV_KEY = 'memory:cache';
export const MEMORY_KV_TTL_SECONDS = 24 * 60 * 60;

export async function getMemory(env: Env): Promise<string> {
  // 1) KV 缓存（24h TTL，每天 04:00 归档任务会刷新）
  try {
    const cached = await env.KV.get(MEMORY_KV_KEY);
    if (cached !== null) return cached;
  } catch (e) {
    console.error('[memory] KV read failed:', e);
  }
  // 2) 回源 R2（主账号优先，小号兜底）并重建缓存
  try {
    const obj = await getObject(env, MEMORY_R2_KEY);
    if (obj === null) return ''; // 首次使用还没有记忆文件
    const text = await obj.text();
    await env.KV.put(MEMORY_KV_KEY, text, { expirationTtl: MEMORY_KV_TTL_SECONDS }).catch(() => {});
    return text;
  } catch (e) {
    console.error('[memory] R2 read failed:', e);
    return ''; // 记忆不可用时降级为空，聊天照常
  }
}

export async function putMemory(env: Env, text: string): Promise<void> {
  // 先删旧缓存（等效"手动失效"，避免覆盖失败时残留旧值）
  await env.KV.delete(MEMORY_KV_KEY).catch(() => {});
  await putObject(env, MEMORY_R2_KEY, text);
  await env.KV.put(MEMORY_KV_KEY, text, { expirationTtl: MEMORY_KV_TTL_SECONDS }).catch((e) => {
    // KV 写失败时缓存已删除，下次读取会回源 R2，不会读到旧值
    console.error('[memory] KV write failed (cache cleared, next read re-sources R2):', e);
  });
}
