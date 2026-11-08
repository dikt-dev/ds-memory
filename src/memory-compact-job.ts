/**
 * 跨分区去重作业（2026-11-08）。
 *
 * 每天在 collapseOngoingItems 之后跑：承诺优先、近期动态让位给共同经历。
 * 复用别的记忆写入同一套安全顺序：备份 → 校验（宪法节未变）→ putMemory。
 */
import type { Env } from './types';
import { dateKeyInBeijing } from './date';
import { getMemory, putMemory } from './memory';
import { putObject } from './storage';
import { recordAction } from './memory-actions';
import { byteLength } from './memory-maintenance';
import { constitutionBlocks, crossSectionPass } from './memory-compact';
import { replaceMemoryContext } from './memory-context-store';

export interface CompactOutcome {
  removed: number;
  promiseDuplicates: number;
  recentDuplicates: number;
  beforeBytes: number;
  afterBytes: number;
  skipped?: 'off' | 'unchanged' | 'write_failed' | 'constitution_changed';
}

export async function compactMemoryCrossSection(env: Env): Promise<CompactOutcome> {
  if ((env.MEMORY_COMPACT ?? '').toLowerCase() === 'off') {
    return { removed: 0, promiseDuplicates: 0, recentDuplicates: 0, beforeBytes: 0, afterBytes: 0, skipped: 'off' };
  }
  const before = await getMemory(env);
  if (!before.trim()) {
    return { removed: 0, promiseDuplicates: 0, recentDuplicates: 0, beforeBytes: 0, afterBytes: 0, skipped: 'unchanged' };
  }
  const result = crossSectionPass(before);
  if (result.removed.length === 0) {
    return {
      removed: 0, promiseDuplicates: 0, recentDuplicates: 0,
      beforeBytes: byteLength(before), afterBytes: byteLength(before), skipped: 'unchanged',
    };
  }
  // 宪法三节必须一字未动：这是唯一不能出错的约束
  if (JSON.stringify(constitutionBlocks(before)) !== JSON.stringify(constitutionBlocks(result.text))) {
    return {
      removed: 0, promiseDuplicates: 0, recentDuplicates: 0,
      beforeBytes: byteLength(before), afterBytes: byteLength(before), skipped: 'constitution_changed',
    };
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupKey = 'memory/compact/' + stamp + '.md';
  await putObject(env, backupKey, before, { contentType: 'text/markdown' }).catch(() => {});
  const written = await putMemory(env, result.text, 'job');
  if (!written) {
    return {
      removed: 0, promiseDuplicates: 0, recentDuplicates: 0,
      beforeBytes: byteLength(before), afterBytes: byteLength(before), skipped: 'write_failed',
    };
  }
  await recordAction(env, {
    actor: 'agent',
    kind: 'memory.write',
    intent: '跨分区去重：承诺只留一处、近期动态让位给共同经历',
    evidence: result.removed.map((l) => l.slice(0, 60)),
    diff: '移出 ' + result.removed.length + ' 条（备份 ' + backupKey + '）',
    before: result.promiseDuplicates + ' 条承诺重复 / ' + result.recentDuplicates + ' 条近期重复',
    after: '承诺与事件各一处',
    revertible: true,
  }, Date.now()).catch(() => {});
  // 派生数据跟着重建（chunk 缓存 / facts / events）：别的记忆写入都走这一步
  await replaceMemoryContext(env, result.text, 'legacy').catch(() => null);
  return {
    removed: result.removed.length,
    promiseDuplicates: result.promiseDuplicates,
    recentDuplicates: result.recentDuplicates,
    beforeBytes: byteLength(before),
    afterBytes: byteLength(result.text),
  };
}

/** 每日只跑一次的标记（KV，读多写少）。 */
const MARKER_PREFIX = 'compact:at:';

/**
 * 每天跑一次跨分区去重。
 *
 * 为什么不是只在 04:00 cron 跑：那条链路一旦失败（或那天归档卡住），
 * 折叠就要等到明天。挂在白天/夜间 tick 上、用 KV 标记保证一天只跑一次，
 * 54000ms 内就能生效，也让「今天该做的维护」不依赖单一路径。
 */
export async function maybeCompactMemoryOnceDaily(
  env: Env,
  now: Date = new Date(),
): Promise<CompactOutcome | null> {
  if ((env.MEMORY_COMPACT ?? '').toLowerCase() === 'off') return null;
  const day = dateKeyInBeijing(now);
  const marker = MARKER_PREFIX + day;
  const done = await env.KV.get(marker).catch(() => null);
  if (done) return null;
  const out = await compactMemoryCrossSection(env);
  // 只有真的跑过（含「没有重复」）才打标记；写失败/宪法校验失败下次重试
  if (!out.skipped || out.skipped === 'unchanged') {
    await env.KV.put(marker, String(Date.now()), { expirationTtl: 3 * 24 * 3600 }).catch(() => {});
  }
  return out;
}
