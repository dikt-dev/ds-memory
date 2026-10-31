/**
 * memory-snapshot.ts —— 记忆每日快照（见 docs/memory-rollback-plan.md）
 *
 * 为什么要有：memory.md 每天 04:00 被覆盖写一次，一年 365 次，而写后校验只能证明
 * 「写进去了、没被截断」，证明不了「写进去的是对的」。提炼跑偏时 diff 很小、影响很长。
 *
 * 三条约定：
 *   1. 写在 putMemory **之前** —— 要的是「本日写入前」的状态；
 *   2. 一天只写一次（已存在就跳过）—— 重跑归档不覆盖，保持「当天开始时的样子」；
 *   3. 失败不阻断归档 —— 快照是保险，不是前置条件。
 */
import type { Env } from './types';
import { deleteObject, getObject, headObject, listKeys, putObject } from './storage';
import { getMemory, putMemory } from './memory';
import { logError, logWarn } from './error-log';

export const SNAPSHOT_PREFIX = 'memory/snapshots/';
/** 保留天数：每天约 12KB，45 天约 540KB */
export const SNAPSHOT_KEEP = 45;

/** 只认 `memory/snapshots/YYYY-MM-DD.md`。清理是删除操作，必须严格匹配。 */
const SNAPSHOT_KEY_RE = /^memory\/snapshots\/(\d{4}-\d{2}-\d{2})\.md$/;

export function snapshotKey(dateKey: string): string {
  return `${SNAPSHOT_PREFIX}${dateKey}.md`;
}

export function parseSnapshotKey(key: string): string | null {
  const m = SNAPSHOT_KEY_RE.exec(key);
  return m ? m[1] : null;
}

export interface SnapshotResult {
  written: boolean;
  key: string;
  skipped?: 'disabled' | 'exists' | 'failed';
}

/** 写当天快照。已存在则不覆盖；任何异常都吞掉，只记日志。 */
export async function writeDailySnapshot(
  env: Env,
  dateKey: string,
  text: string,
): Promise<SnapshotResult> {
  const key = snapshotKey(dateKey);
  if (env.MEMORY_SNAPSHOT === 'off') return { written: false, key, skipped: 'disabled' };
  if (!text.trim()) return { written: false, key, skipped: 'failed' };
  try {
    const exists = await headObject(env, key);
    if (exists !== null) return { written: false, key, skipped: 'exists' };
    await putObject(env, key, text, { contentType: 'text/markdown' });
    return { written: true, key };
  } catch (e) {
    logError('[snapshot] write failed (archive continues):', e);
    return { written: false, key, skipped: 'failed' };
  }
}

/** 列出可用快照，按日期倒序。 */
export async function listSnapshots(env: Env): Promise<Array<{ date: string; key: string }>> {
  const keys = await listKeys(env, SNAPSHOT_PREFIX).catch(() => []);
  return keys
    .map((key) => ({ key, date: parseSnapshotKey(key) }))
    .filter((x): x is { key: string; date: string } => x.date !== null)
    .map((x) => ({ date: x.date, key: x.key }))
    .sort((a, b) => b.date.localeCompare(a.date));
}

/** 只保留最近 keep 份；只会删严格匹配命名规则的 key。 */
export async function pruneSnapshots(env: Env, keep = SNAPSHOT_KEEP): Promise<string[]> {
  const keys = (await listKeys(env, SNAPSHOT_PREFIX))
    .filter((k) => SNAPSHOT_KEY_RE.test(k))
    .sort();
  const stale = keys.slice(0, Math.max(0, keys.length - Math.max(1, keep)));
  for (const key of stale) await deleteObject(env, key);
  return stale;
}
export interface RestoreResult {
  restored: boolean;
  date: string;
  bytes: number;
  /** 覆盖前的现役记忆备份 key（恢复错了还能再回来）。 */
  backupKey: string | null;
  reason?: 'bad_date' | 'missing' | 'locked' | 'write_failed' | 'empty';
}

const RESTORE_LOCK_KEY = 'memory:restore-lock';
const RESTORE_LOCK_TTL = 60;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 从快照恢复记忆（见 docs/memory-rollback-plan.md）。
 *
 * 恢复是**破坏性**操作，所以三道保险：
 *   1. 60 秒写锁 —— 防两次请求同时恢复、也防和 04:00 归档撞车；
 *   2. 覆盖前先把现役记忆备份到 memory/restore-backups/ —— 恢复错了能再回退；
 *   3. 写回走 putMemory（带读回校验），校验不过就当失败，不谎报成功。
 *
 * 索引/context 的重建交给调用方（要用 env 里的 reindexMemory），这里只保证 R2 正确。
 */
export async function restoreSnapshot(env: Env, dateKey: string): Promise<RestoreResult> {
  const date = dateKey.trim();
  if (!DATE_RE.test(date)) {
    return { restored: false, date, bytes: 0, backupKey: null, reason: 'bad_date' };
  }

  // 1) 写锁：KV 的 put 不是原子的，但两次真正并发的概率极低，
  //    这里要防的是「误触发两次」「归档正在进行」这类分钟级重叠。
  const held = await env.KV.get(RESTORE_LOCK_KEY).catch(() => null);
  if (held !== null) {
    return { restored: false, date, bytes: 0, backupKey: null, reason: 'locked' };
  }
  await env.KV.put(RESTORE_LOCK_KEY, String(Date.now()), {
    expirationTtl: RESTORE_LOCK_TTL,
  }).catch(() => {});

  try {
    const obj = await getObject(env, snapshotKey(date)).catch(() => null);
    if (obj === null) {
      return { restored: false, date, bytes: 0, backupKey: null, reason: 'missing' };
    }
    const text = await obj.text();
    if (!text.trim()) {
      return { restored: false, date, bytes: 0, backupKey: null, reason: 'empty' };
    }

    // 2) 先备份现役记忆
    let backupKey: string | null = null;
    const current = await getMemory(env);
    if (current.trim()) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      backupKey = `memory/restore-backups/${stamp}-before-${date}.md`;
      await putObject(env, backupKey, current, { contentType: 'text/markdown' }).catch(() => {
        backupKey = null;
      });
    }

    // 3) 写回（带读回校验），失败就明确失败
    const ok = await putMemory(env, text);
    if (!ok) {
      return { restored: false, date, bytes: 0, backupKey, reason: 'write_failed' };
    }
    return { restored: true, date, bytes: text.length, backupKey };
  } finally {
    await env.KV.delete(RESTORE_LOCK_KEY).catch(() => {});
  }
}


