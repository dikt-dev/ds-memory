/**
 * 往 memory.md 的某个分区补一行（幂等、可审计）。
 *
 * 从 admin 路由里抽出来的：旅行回来要自动写一条「去了杭州」，
 * 手动补字段（样貌）也要走同一条路——备份、写闸口、审计、重建派生数据，
 * 少一样都会让记忆和派生数据对不上。
 */
import type { Env } from './types';
import { getMemoryFresh, putMemory } from './memory';
import { putObject } from './storage';
import { recordAction } from './memory-actions';
import { SECTION_COMMENTS, SECTION_ORDER, byteLength } from './memory-maintenance';
import { replaceMemoryContext } from './memory-context-store';


export interface AppendResult {
  applied: boolean;
  reason?: string;
  backupKey?: string;
}

/** 纯文本变换：把一行插进分区。分区不存在就按标准顺序新建。 */
export function insertLineIntoText(
  before: string,
  section: string,
  line: string,
): { text: string; reason?: string } {
  const target = section.trim();
  const row = line.trim();
  let lines = before.split('\n');
  let head = lines.findIndex((x) => x.trim() === target);
  let created = false;

  if (head < 0) {
    if (!SECTION_ORDER.includes(target)) return { text: before, reason: 'no-section' };
    const nextSections = SECTION_ORDER.slice(SECTION_ORDER.indexOf(target) + 1);
    const insertAt = lines.findIndex((x) => nextSections.some((s) => x.trim() === s));
    const comment = SECTION_COMMENTS[target];
    // 别在文末留空段：有下一节就插在它前面
    const block = [target, ...(comment ? ['', comment] : []), '', row, ''];
    lines =
      insertAt < 0
        ? [...lines, '', ...block]
        : [...lines.slice(0, insertAt), ...block, ...lines.slice(insertAt)];
    head = lines.findIndex((x) => x.trim() === target);
    created = true;
  }

  let tail = lines.findIndex((x, i) => i > head && x.startsWith('## '));
  if (tail < 0) tail = lines.length;
  const inSection = lines.slice(head + 1, tail);

  // 幂等：整行已存在就不重复写（cron 一天可能跑多次）。
  // 不能拿「关键词 + 行首是短横线」当判据——含同名词的旧行会被误判成已存在。
  if (!created && inSection.some((x) => x.trim() === row || x.includes(row))) {
    return { text: before, reason: 'exists' };
  }

  // 新建分区时 block 里已经带着这一行，不能再插一次（会变成两条一模一样）
  if (created) return { text: lines.join('\n') };

  // 追到分区最后一条之后（按时间顺序往下排），而不是紧贴标题
  let last = head;
  for (let i = head + 1; i < tail; i++) if (lines[i].trim()) last = i;
  return { text: [...lines.slice(0, last + 1), row, ...lines.slice(last + 1)].join('\n') };
}

/** 往「## 分区」插一条：备份原文 → 写闸门 → 记 memory_actions → 重建派生数据。 */
export async function appendMemoryLine(
  env: Env,
  input: { section: string; line: string; keyword?: string; actor?: 'human' | 'job' },
): Promise<AppendResult> {
  const section = input.section.trim();
  const line = input.line.trim();
  if (!section.startsWith('## ') || !line) return { applied: false, reason: 'bad-input' };

  const before = await getMemoryFresh(env);
  if (!before.trim()) return { applied: false, reason: 'no-memory' };
  const { text: after, reason } = insertLineIntoText(before, section, line);
  if (reason) return { applied: false, reason };

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupKey = `memory/append/${stamp}.md`;
  await putObject(env, backupKey, before, { contentType: 'text/markdown' }).catch(() => {});
  const written = await putMemory(env, after, input.actor ?? 'job');
  if (!written) return { applied: false, reason: 'write-failed', backupKey };

  await recordAction(
    env,
    {
      actor: input.actor ?? 'job',
      kind: 'memory.write',
      intent: `在「${section.replace('## ', '')}」补一行：${line.slice(0, 40)}`,
      evidence: [backupKey],
      diff: `+ ${line}`,
      before: `${byteLength(before)} 字节`,
      after: `${byteLength(after)} 字节`,
      revertible: true,
    },
    Date.now(),
  ).catch(() => {});

  await replaceMemoryContext(env, after, 'legacy').catch(() => null);
  return { applied: true, backupKey };
}

/** 删掉完全匹配的一行（测试/纠错用：只认整行相等，不做模糊删除）。 */
export async function removeMemoryLine(
  env: Env,
  line: string,
): Promise<{ removed: boolean; reason?: string }> {
  const target = line.trim();
  if (!target) return { removed: false, reason: 'empty' };
  const before = await getMemoryFresh(env);
  const lines = before.split('\n');
  const idx = lines.findIndex((x) => x.trim() === target);
  if (idx < 0) return { removed: false, reason: 'not-found' };

  const after = [...lines.slice(0, idx), ...lines.slice(idx + 1)].join('\n');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupKey = `memory/remove/${stamp}.md`;
  await putObject(env, backupKey, before, { contentType: 'text/markdown' }).catch(() => {});
  const written = await putMemory(env, after, 'human');
  if (!written) return { removed: false, reason: 'write-failed' };
  await recordAction(
    env,
    {
      actor: 'human',
      kind: 'memory.write',
      intent: `删掉一行：${target.slice(0, 40)}`,
      evidence: [backupKey],
      diff: `- ${target}`,
      before: `${byteLength(before)} 字节`,
      after: `${byteLength(after)} 字节`,
      revertible: true,
    },
    Date.now(),
  ).catch(() => {});
  await replaceMemoryContext(env, after, 'legacy').catch(() => null);
  return { removed: true };
}
