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
import { collapseOngoingItems } from './memory-ongoing-job';
import { refreshChunksCache } from './memory-context-store';

export interface CompactOutcome {
  removed: number;
  promiseDuplicates: number;
  recentDuplicates: number;
  beforeBytes: number;
  afterBytes: number;
  skipped?: 'off' | 'unchanged' | 'write_failed' | 'constitution_changed';
}

export async function compactMemoryCrossSection(env: Env): Promise<CompactOutcome> {
  // 直接调用（04:00 链路或管理端）时也要打维护标记，评估脚本同样会等。
  await env.KV.put('maintenance:running', '1', { expirationTtl: 180 }).catch(() => {});
  if ((env.MEMORY_COMPACT ?? '').toLowerCase() === 'off') {
    return { removed: 0, promiseDuplicates: 0, recentDuplicates: 0, beforeBytes: 0, afterBytes: 0, skipped: 'off' };
  }
  const before = await getMemory(env);
  if (!before.trim()) {
    return { removed: 0, promiseDuplicates: 0, recentDuplicates: 0, beforeBytes: 0, afterBytes: 0, skipped: 'unchanged' };
  }
  const result = crossSectionPass(before);
  // 用「文本是否变化」判断，而不是「有没有删行」：加锚点不删行，但也需要写回。
  if (result.text === before) {
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
  // 只维护召回真正用的 chunk 缓存；facts/events 已停自动维护（2026-11-08）
  await refreshChunksCache(env, result.text).catch(() => null);
  await env.KV.delete('maintenance:running').catch(() => {});
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
  // 维护窗口标记：/api/health 会报 maintenance=true，评估脚本据此等待，
  // 免得量到「记忆正在被改写」的中间态（TTL 兜底，异常也不会永久卡住）。
  await env.KV.put('maintenance:running', '1', { expirationTtl: 180 }).catch(() => {});
  // 先把「进行中的事」里的同实体多版本并掉（原来只在 04:00 跑，一条链路失败就拖一天），
  // 再做跨分区去重：顺序反了会把刚并掉的行又当成重复删一遍。
  await collapseOngoingItems(env).catch(() => null);
  const out = await compactMemoryCrossSection(env);
  // 只有真的跑过（含「没有重复」）才打标记；写失败/宪法校验失败下次重试
  if (!out.skipped || out.skipped === 'unchanged') {
    await env.KV.put(marker, String(Date.now()), { expirationTtl: 3 * 24 * 3600 }).catch(() => {});
  }
  await env.KV.delete('maintenance:running').catch(() => {});
  return out;
}
