/**
 * 缓存预热。
 *
 * 为什么要它：召回读 memory_chunks 的 KV 缓存，但缓存只有归档任务会写——
 * 刚部署/刚改记忆时是冷的，第一次聊天要多等一次全表查询（实测 ~1.5s）。
 *
 * 策略：
 * - 进程内标记，同一个 isolate 只试一次；
 * - KV 里放一个 1 小时的标记，跨 isolate 也只每小时真正预热一次（写 24 次/天）；
 * - 真正干活放在 waitUntil，不阻塞这一轮回复。
 */
import type { Env } from './types';
import { refreshChunksCache } from './memory-context-store';
import { ensureContextSnapshot } from './context-snapshot';
import { logError } from './error-log';

export const PREWARM_MARKER_KEY = 'cache:prewarm:at';
export const PREWARM_MIN_GAP_MS = 60 * 60 * 1000;

let warmedThisIsolate = false;

export async function maybePrewarmCaches(
  env: Env,
  ctx: { waitUntil: (p: Promise<unknown>) => void },
  now = new Date(),
): Promise<void> {
  if (warmedThisIsolate) return;
  warmedThisIsolate = true;
  try {
    const marker = await env.KV.get(PREWARM_MARKER_KEY).catch(() => null);
    const at = marker ? Number(marker) : 0;
    if (Number.isFinite(at) && at > 0 && now.getTime() - at < PREWARM_MIN_GAP_MS) return;
    ctx.waitUntil(
      (async () => {
        await refreshChunksCache(env).catch((e: unknown) => logError('[prewarm] chunks failed:', e));
        await ensureContextSnapshot(env, now).catch(() => false);
        await env.KV.put(PREWARM_MARKER_KEY, String(Date.now()), { expirationTtl: 86400 }).catch(() => undefined);
      })(),
    );
  } catch (e) {
    logError('[prewarm] skipped:', e);
  }
}
