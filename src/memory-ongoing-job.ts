/**
 * 每天凌晨扫一遍「进行中的事项」，把同主题的旧状态行并掉。
 *
 * 保留策略在 memory-ongoing.ts 里（纯函数、有单测）；这里负责：
 * 备份 → 写 → 审计 → 重建派生数据，和别的记忆写入走同一套。
 */
import type { Env } from './types';
import { getMemory, putMemory } from './memory';
import { putObject } from './storage';
import { recordAction } from './memory-actions';
import { replaceMemoryContext } from './memory-context-store';
import { byteLength } from './memory-maintenance';
import { collapseOngoing } from './memory-ongoing';

export interface CollapseOutcome {
  removed: number;
  lines: string[];
  backupKey?: string;
}

export async function collapseOngoingItems(env: Env): Promise<CollapseOutcome> {
  const before = await getMemory(env);
  if (!before.trim()) return { removed: 0, lines: [] };

  const { text, removed } = collapseOngoing(before);
  if (removed.length === 0) return { removed: 0, lines: [] };

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupKey = `memory/ongoing/${stamp}.md`;
  await putObject(env, backupKey, before, { contentType: 'text/markdown' }).catch(() => {});
  const written = await putMemory(env, text, 'job');
  if (!written) return { removed: 0, lines: [] };

  await recordAction(
    env,
    {
      actor: 'job',
      kind: 'memory.write',
      intent: `合并「进行中的事项」里同主题的旧状态行（${removed.length} 条）`,
      evidence: [backupKey],
      diff: removed.map((l) => `- ${l}`).join('\n'),
      before: `${byteLength(before)} 字节`,
      after: `${byteLength(text)} 字节`,
      revertible: true,
    },
    Date.now(),
  ).catch(() => {});

  await replaceMemoryContext(env, text, 'legacy').catch(() => null);
  return { removed: removed.length, lines: removed, backupKey };
}
