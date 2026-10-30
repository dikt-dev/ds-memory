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
import { deleteObject, headObject, listKeys, putObject } from './storage';

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
    console.error('[snapshot] write failed (archive continues):', e);
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