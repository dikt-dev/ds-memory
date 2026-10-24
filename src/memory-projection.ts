/**
 * memory.md 投影落盘（Phase 2B，手动/Phase 5 切投影用）。
 *
 * 安全顺序：生成 → 校验 → 备份旧文件 → 写新文件。
 * 默认不自动执行；只通过受保护的管理接口触发。
 */
import type { Env } from './types';
import { getMemory, putMemory } from './memory';
import {
  canonicalizeFacts,
  parseMemoryContext,
  projectMemoryContext,
  type ParsedMemoryContext,
} from './memory-domain';
import { loadMemoryContext } from './memory-context-store';
import { putObject } from './storage';

export const PROJECTION_MAX_BYTES = 16 * 1024;
const CORE_HEADERS = ['## 人物底色', '## 称呼与关系', '## 雷区与禁忌'];

export interface ProjectionResult {
  beforeBytes: number;
  afterBytes: number;
  backupKey: string;
  facts: number;
  events: number;
}

export function validateProjection(before: string, after: string): string[] {
  const errors: string[] = [];
  if (!after.trim()) errors.push('projection empty');
  if (new TextEncoder().encode(after).length > PROJECTION_MAX_BYTES) {
    errors.push(`projection exceeds ${PROJECTION_MAX_BYTES} bytes`);
  }
  if (!after.startsWith('# 长期记忆')) errors.push('missing memory title');
  for (const header of CORE_HEADERS) {
    if (before.includes(header) && !after.includes(header)) {
      errors.push(`pinned section lost: ${header}`);
    }
  }
  return errors;
}

/** 生成投影（只读），供预览与写回共用。 */
export async function buildMemoryProjection(
  env: Env,
  now = Date.now(),
): Promise<{ before: string; parsed: ParsedMemoryContext; projection: string }> {
  const before = await getMemory(env);
  if (!before.trim()) throw new Error('memory.md is empty; refusing to project');
  let parsed: ParsedMemoryContext;
  try {
    const stored = await loadMemoryContext(env);
    parsed =
      stored.facts.length > 0 || stored.events.length > 0
        ? {
            facts: canonicalizeFacts(
              stored.facts,
              new Date(now + 8 * 3600 * 1000).toISOString().slice(0, 10),
            ),
            events: stored.events,
          }
        : parseMemoryContext(before);
  } catch {
    // 新表未迁移时仍可投影当前 memory.md
    parsed = parseMemoryContext(before);
  }
  return { before, parsed, projection: projectMemoryContext(before, parsed) };
}

export async function applyMemoryProjection(env: Env, now = Date.now()): Promise<ProjectionResult> {
  const { before, parsed, projection: after } = await buildMemoryProjection(env, now);
  const errors = validateProjection(before, after);
  if (errors.length > 0) throw new Error(`projection validation failed: ${errors.join('; ')}`);

  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  const backupKey = `memory/backup/memory-${stamp}.md`;
  await putObject(env, backupKey, before, { contentType: 'text/markdown' });
  await putMemory(env, after);

  const bytes = (s: string) => new TextEncoder().encode(s).length;
  return {
    beforeBytes: bytes(before),
    afterBytes: bytes(after),
    backupKey,
    facts: parsed.facts.length,
    events: parsed.events.length,
  };
}
