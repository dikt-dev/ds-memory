/**
 * 轻量记忆审计：先记录“谁改了什么、前后指纹”，不引入哈希链。
 * 借鉴 LRC 的可追溯性，但保持 Worker/D1 的成本。
 */
import type { Env } from './types';
import { stableHash } from './memory-domain';
import { logError, logWarn } from './error-log';

export interface MemoryAuditInput {
  action: 'correct' | 'link_backfill' | 'rebuild' | 'archive';
  targetType: 'memory.md' | 'fact' | 'link';
  targetId: string;
  beforeHash?: string | null;
  afterHash?: string | null;
  source: string;
  detail?: string | null;
}

export async function recordMemoryAudit(env: Env, input: MemoryAuditInput): Promise<void> {
  const id = `audit_${stableHash(
    `${input.action}|${input.targetType}|${input.targetId}|${Date.now()}|${Math.random()}`,
  )}`;
  await env.DB.prepare(
    `INSERT INTO memory_audit
     (id, action, target_type, target_id, before_hash, after_hash, source, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      input.action,
      input.targetType,
      input.targetId,
      input.beforeHash ?? null,
      input.afterHash ?? null,
      input.source,
      input.detail ? input.detail.slice(0, 500) : null,
      Date.now(),
    )
    .run()
    .catch((e) => logWarn('[memory:audit] write failed:', e));
}

export function auditHash(text: string): string {
  return stableHash(text);
}
