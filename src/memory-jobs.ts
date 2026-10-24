/**
 * 可重试的记忆任务（Phase 2B）。
 *
 * 当前只做轻量 D1 任务，不引入队列服务：
 * - queued → running → done/failed；
 * - 每次 cron 最多处理 N 个，失败保留 error/attempts 供重试；
 * - 任务类型：rebuild_context / sync_summaries / backfill_provenance。
 */
import type { Env } from './types';
import { getMemory } from './memory';
import { getArchiveLines } from './memory-archive';
import {
  backfillMemoryProvenance,
  replaceMemoryContext,
  syncArchiveContext,
  syncRollupSummaries,
  upsertConversationFacts,
} from './memory-context-store';
import { extractFactsFromMessages } from './memory-extract';

export type MemoryJobType =
  | 'rebuild_context'
  | 'sync_summaries'
  | 'sync_archive'
  | 'backfill_provenance'
  | 'extract_conversation';

export interface MemoryJob {
  id: string;
  type: MemoryJobType;
  target: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  attempts: number;
  created_at: number;
}

export interface MemoryJobRunResult {
  processed: number;
  failed: number;
  details: Array<{ id: string; type: string; ok: boolean; error?: string }>;
}

export async function enqueueMemoryJob(
  env: Env,
  type: MemoryJobType,
  target = '',
  now = Date.now(),
): Promise<string> {
  const id = `mjob_${now}_${crypto.randomUUID().slice(0, 8)}`;
  await env.DB.prepare(
    `INSERT OR IGNORE INTO memory_jobs (id, type, target, status, attempts, created_at)
     VALUES (?, ?, ?, 'queued', 0, ?)`,
  )
    .bind(id, type, target, now)
    .run();
  return id;
}

/** 取最早 queued 任务并原子标记为 running。 */
export async function claimMemoryJob(env: Env, now = Date.now()): Promise<MemoryJob | null> {
  const row = await env.DB.prepare(
    `SELECT id, type, target, status, attempts, created_at
     FROM memory_jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1`,
  ).first<MemoryJob>();
  if (!row) return null;
  const res = await env.DB.prepare(
    `UPDATE memory_jobs
     SET status = 'running', attempts = attempts + 1, started_at = ?
     WHERE id = ? AND status = 'queued'`,
  )
    .bind(now, row.id)
    .run();
  if ((res.meta.changes ?? 0) === 0) return null;
  return { ...row, status: 'running', attempts: row.attempts + 1 };
}

export async function finishMemoryJob(
  env: Env,
  id: string,
  ok: boolean,
  error = '',
  now = Date.now(),
): Promise<void> {
  await env.DB.prepare(
    `UPDATE memory_jobs
     SET status = ?, error = ?, finished_at = ?
     WHERE id = ?`,
  )
    .bind(ok ? 'done' : 'failed', ok ? null : error.slice(0, 500), now, id)
    .run();
}

async function runOne(env: Env, job: MemoryJob): Promise<unknown> {
  switch (job.type) {
    case 'rebuild_context': {
      const memory = await getMemory(env);
      return replaceMemoryContext(env, memory, 'memory');
    }
    case 'sync_summaries':
      return { summaries: await syncRollupSummaries(env) };
    case 'sync_archive': {
      const lines = await getArchiveLines(env);
      return { archived: await syncArchiveContext(env, lines) };
    }
    case 'backfill_provenance':
      return { linked: await backfillMemoryProvenance(env) };
    case 'extract_conversation': {
      const since = Date.now() - 3 * 86400000;
      const rows = await env.DB.prepare(
        `SELECT id, role, content, date_key, created_ms
         FROM messages
         WHERE role = 'user' AND created_ms >= ?
         ORDER BY id DESC LIMIT 300`,
      )
        .bind(since)
        .all<{
          id: number;
          role: 'user' | 'assistant';
          content: string;
          date_key: string;
          created_ms: number;
        }>();
      const facts = extractFactsFromMessages(
        (rows.results ?? []).map((r) => ({
          id: r.id,
          role: r.role,
          content: r.content,
          dateKey: r.date_key,
          createdAt: r.created_ms,
        })),
      );
      return { extracted: await upsertConversationFacts(env, facts) };
    }
    default:
      throw new Error(`unknown memory job type: ${job.type}`);
  }
}

/** 处理最多 limit 个 queued 任务。单个任务失败不影响其它任务。 */
export async function runMemoryJobs(
  env: Env,
  now = new Date(),
  limit = 3,
): Promise<MemoryJobRunResult> {
  const result: MemoryJobRunResult = { processed: 0, failed: 0, details: [] };
  for (let i = 0; i < Math.max(1, limit); i++) {
    const job = await claimMemoryJob(env, now.getTime());
    if (!job) break;
    try {
      await runOne(env, job);
      await finishMemoryJob(env, job.id, true, '', now.getTime());
      result.processed += 1;
      result.details.push({ id: job.id, type: job.type, ok: true });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await finishMemoryJob(env, job.id, false, message, now.getTime());
      result.failed += 1;
      result.details.push({ id: job.id, type: job.type, ok: false, error: message });
    }
  }
  return result;
}
