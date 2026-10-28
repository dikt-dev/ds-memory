/**
 * 用户显式纠正长期记忆。
 *
 * 设计目标：
 * - 只接受用户主动发送的纠正，不做“猜测式改写”；
 * - 带 key 的纠正（职业=...、名字=...）直接替换旧行，避免新旧事实并存；
 * - 无法识别 key 时写入独立的「用户更正」区，优先级高于旧摘要；
 * - 写入 R2 memory.md 后同步刷新 KV、facts/chunks 和检索索引。
 */
import type { Env } from './types';
import { getMemory, putMemory } from './memory';
import { dateKeyInBeijing } from './date';
import { embedMemoryChunks, replaceMemoryContext, syncRollupSummaries } from './memory-context-store';
import { reindexMemory } from './memory-index';
import { generateRollup, weekStartKey } from './memory-rollups';
import { auditHash, recordMemoryAudit } from './memory-audit';

const CORRECTION_HEADER = '## 用户更正（最高优先级）';
const MAX_LEN = 500;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function insertCorrectionSection(memory: string, line: string): string {
  const existing = memory.match(
    /(## 用户更正（最高优先级）\n)([\s\S]*?)(?=\n## |$)/,
  );
  if (existing) {
    if (existing[2].includes(line)) return memory;
    return memory.replace(existing[0], `${existing[1]}${existing[2].trimEnd()}\n${line}\n`);
  }
  const section = `${CORRECTION_HEADER}\n${line}\n\n`;
  // 放在人物底色之后、其他记忆之前，确保它先于旧事实进入上下文。
  const anchor = memory.indexOf('\n## ');
  if (anchor < 0) return `${memory.trimEnd()}\n\n${section}`;
  return `${memory.slice(0, anchor + 1)}${section}${memory.slice(anchor + 1)}`;
}

export interface CorrectionResult {
  ok: boolean;
  keyed: boolean;
  line: string;
  bytes: number;
}

export async function applyMemoryCorrection(
  env: Env,
  raw: string,
  now: Date = new Date(),
): Promise<CorrectionResult> {
  const text = raw.trim().replace(/^\/更正\s*/, '').trim().slice(0, MAX_LEN);
  if (!text) throw new Error('纠正内容为空');

  const memory = await getMemory(env);
  const date = dateKeyInBeijing(now);
  const dateTag = date.slice(2); // YY-MM-DD，和 memory.md 现有条目一致
  const line = `- [${dateTag}] ${text}`;

  // 形如 `职业=嵌入式开发` / `称呼：大人`：替换同一个 key 的旧条目。
  const kv = text.match(/^([^=：:\n]{1,24})\s*[=：:]\s*(.+)$/);
  let next = memory;
  let keyed = false;
  if (kv) {
    const key = kv[1].trim();
    const keyPattern = new RegExp(
      `^-\\s*\\[[^\\]]+\\]\\s*${escapeRegExp(key)}\\s*[=：:].*$`,
      'm',
    );
    if (keyPattern.test(next)) {
      next = next.replace(keyPattern, `- [${dateTag}] ${key}=${kv[2].trim()}`);
      keyed = true;
    }
  }
  if (!keyed) {
    next = insertCorrectionSection(next, line);
  }

  if (next === memory) {
    return { ok: true, keyed, line, bytes: new TextEncoder().encode(memory).byteLength };
  }

  const beforeHash = auditHash(memory);
  await putMemory(env, next);
  await recordMemoryAudit(env, {
    action: 'correct',
    targetType: 'memory.md',
    targetId: 'memory.md',
    beforeHash,
    afterHash: auditHash(next),
    source: 'api:/更正',
    detail: text,
  });
  // 纠正属于低频操作，直接同步重建，避免下一轮仍召回旧事实。
  await replaceMemoryContext(env, next, 'correction').catch((e) => {
    console.error('[memory] correction context rebuild failed:', e);
  });
  await reindexMemory(env).catch((e) => {
    console.error('[memory] correction reindex failed:', e);
  });

  // 摘要也是记忆的派生缓存：纠正后让当前周/月 rollup 重新生成，
  // 否则旧月摘要可能在下次 syncRollupSummaries 时把旧事实带回来。
  try {
    const today = dateKeyInBeijing(now);
    const week = weekStartKey(today);
    const month = today.slice(0, 7);
    await env.DB.prepare('DELETE FROM memory_rollups WHERE id IN (?, ?)')
      .bind(`week:${week}`, `month:${month}`)
      .run();
    await generateRollup(env, 'week', week, { fresh: true });
    await generateRollup(env, 'month', month, { fresh: true });
    await syncRollupSummaries(env);
    await embedMemoryChunks(env, 200);
  } catch (e) {
    console.error('[memory] correction rollup refresh failed:', e);
  }

  return {
    ok: true,
    keyed,
    line,
    bytes: new TextEncoder().encode(next).byteLength,
  };
}
