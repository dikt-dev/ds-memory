/**
 * 长期记忆读写：R2 memory.md 为源，KV 为 24h 缓存。
 * - 读：KV 命中直接用；miss 回源 R2 并写回（缓存失效后自动重建）。
 * - 写（每日提炼任务）：先删旧缓存再同时更新 R2 与 KV —— 即使旧缓存未过期也强制失效。
 * - 任何存储异常都降级：聊天继续，只是暂时不带记忆，绝不因此 500。
 */
import type { Env } from './types';
import { getObject, putObject } from './storage';
import { assertAllowed, type Actor } from './policy';
import { logError, logWarn } from './error-log';

export const MEMORY_R2_KEY = 'memory.md';
export const MEMORY_KV_KEY = 'memory:cache';
export const MEMORY_KV_TTL_SECONDS = 24 * 60 * 60;

export async function getMemory(env: Env): Promise<string> {
  // 1) KV 缓存（24h TTL，每天 04:00 归档任务会刷新）
  try {
    const cached = await env.KV.get(MEMORY_KV_KEY);
    if (cached !== null) return cached;
  } catch (e) {
    logError('[memory] KV read failed:', e);
  }
  // 2) 回源 R2（主账号优先，小号兜底）并重建缓存
  try {
    const obj = await getObject(env, MEMORY_R2_KEY);
    if (obj === null) return ''; // 首次使用还没有记忆文件
    const text = await obj.text();
    await env.KV.put(MEMORY_KV_KEY, text, { expirationTtl: MEMORY_KV_TTL_SECONDS }).catch(() => {});
    return text;
  } catch (e) {
    logError('[memory] R2 read failed:', e);
    return ''; // 记忆不可用时降级为空，聊天照常
  }
}

/**
 * 读「以 R2 为准」的原文，跳过 KV 缓存。
 *
 * 给「读→改→写」这类操作（补一行、删一行）用：KV 是最终一致的，
 * 刚写完马上读很可能拿到旧版本，改回去就把别人的修改冲掉了——
 * 2026-11-01 真的发生过：删掉一行、紧接着补两行，旧行被从过期快照里带了回来。
 */
export async function getMemoryFresh(env: Env): Promise<string> {
  try {
    const obj = await getObject(env, MEMORY_R2_KEY);
    return obj === null ? '' : await obj.text();
  } catch (e) {
    logError('[memory] R2 fresh read failed:', e);
    return '';
  }
}

/**
 * 写回长期记忆，返回是否**确认落盘**。
 *
 * 旧实现是"删缓存 → put → put 缓存"，三步都不检查结果：R2 单次 put 静默失败时，
 * 当天的 LLM 提炼凭空消失，而调用方仍按新内容重建索引和 Memory Context，
 * 于是索引里有一份 R2 里不存在的记忆 —— 比直接报错更难查。
 * 现在：写后读回比对，不一致就不刷新缓存并返回 false，让调用方跳过派生重建。
 */
/** 存储层统一用 YY-MM-DD（注入提示词时再决定要不要省年份）。 */
export function normalizeMemoryDates(text: string): string {
  return text.replace(/\[(\d{4})-(\d{2})-(\d{2})\]/g, (_all, y: string, m: string, d: string) => `[${y.slice(2)}-${m}-${d}]`);
}

export async function putMemory(
  env: Env,
  text: string,
  actor: Actor = 'job',
): Promise<boolean> {
  text = normalizeMemoryDates(text);
  // 重写长期记忆属于 A 档动作，但必须过闸口：宪法四节的写入在 policy 里是被挡的。
  assertAllowed({ kind: 'memory.write' }, { actor });
  // 1) 先写 R2（唯一真相）。失败时缓存保持旧值：KV 与 R2 仍是**一致**的旧版本。
  try {
    await putObject(env, MEMORY_R2_KEY, text);
  } catch (e) {
    logError('[memory] R2 put failed, cache left untouched:', e);
    return false;
  }

  // 2) 读回校验（内容级，不是大小级：同长度写坏也能发现）
  const echo = await getObject(env, MEMORY_R2_KEY).catch(() => null);
  const stored = echo ? await echo.text().catch(() => null) : null;
  if (stored !== text) {
    logError(
      `[memory] R2 write verify failed (wrote ${text.length} chars, read back ${stored === null ? 'null' : stored.length})`,
    );
    // 缓存里可能是旧版也可能是半截新版，一律作废，下次回源看真实内容。
    await env.KV.delete(MEMORY_KV_KEY).catch(() => {});
    return false;
  }

  // 2.5) 上下文快照里也存了一份 memory：记忆变了必须让它失效，
  //      否则最长 10 分钟里提示词用的还是旧记忆（2026-11-08 踩到）。
  await env.KV.delete('ctx:snapshot:v1').catch(() => {});

  // 3) 校验通过才刷新缓存；KV 失败就删缓存，下次回源 R2 读到的是新内容。
  try {
    await env.KV.put(MEMORY_KV_KEY, text, { expirationTtl: MEMORY_KV_TTL_SECONDS });
  } catch (e) {
    logError('[memory] KV write failed (cache cleared, next read re-sources R2):', e);
    await env.KV.delete(MEMORY_KV_KEY).catch(() => {});
  }
  return true;
}
