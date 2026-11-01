import type { Env } from './types';
import { logWarn } from './error-log';

/**
 * legacy（memory_entries）与 next（memory_chunks/facts/events）的影子和账。
 *
 * 为什么要它：两套索引并存，切 MEMORY_ENGINE=next 之前得**先能看见差异**，
 * 否则切换那天由用户来发现哪条记忆丢了。
 *
 * 这一版只记数量，不改任何索引内容：
 *   数量级都不一致时，逐条比对只是在比对噪声。
 *
 * 开关：KV memory:dual = '1'。关着时这一整个函数只有一次 KV 读。
 */
export interface DualStats {
  date: string;
  legacy: number;
  nextChunks: number;
  nextFacts: number;
  nextEvents: number;
  at: number;
}

const SWITCH_KEY = 'memory:dual';
const STATS_PREFIX = 'memory:dual:';
const TTL_SECONDS = 30 * 24 * 3600;

function dateKey(now: Date): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(now);
}

/** 只允许这几张表：表名会进 SQL 模板，不能是任意字符串。 */
type CountableTable = 'memory_entries' | 'memory_chunks' | 'memory_facts' | 'memory_events';

async function count(env: Env, table: CountableTable): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS c FROM ${table}`)
    .first<{ c: number }>()
    .catch(() => null);
  return row?.c ?? 0;
}

/** 记一笔两边各有多少行；开关关着返回 null，调用方不用判返回值。 */
export async function recordDualStats(env: Env, now = new Date()): Promise<DualStats | null> {
  const enabled = await env.KV.get(SWITCH_KEY).catch(() => null);
  if (enabled !== '1') return null;

  const stats: DualStats = {
    date: dateKey(now),
    legacy: await count(env, 'memory_entries'),
    nextChunks: await count(env, 'memory_chunks'),
    nextFacts: await count(env, 'memory_facts'),
    nextEvents: await count(env, 'memory_events'),
    at: Date.now(),
  };

  await env.KV.put(STATS_PREFIX + stats.date, JSON.stringify(stats), {
    expirationTtl: TTL_SECONDS,
  }).catch((e) => logWarn('[memory-dual] stats write failed:', e));

  // 差得离谱时喊一声：不是让数字对齐，是让人知道「现在两套索引不是一回事」
  const gap = Math.abs(stats.legacy - stats.nextChunks);
  if (stats.nextChunks > 0 && gap / stats.nextChunks > 0.3) {
    logWarn(
      `[memory-dual] 差得有点多：legacy ${stats.legacy} / next ${stats.nextChunks}（facts ${stats.nextFacts}, events ${stats.nextEvents}）`,
    );
  } else {
    logWarn(`[memory-dual] legacy ${stats.legacy} / next ${stats.nextChunks}`);
  }
  return stats;
}
