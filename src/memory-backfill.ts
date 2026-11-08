/**
 * 历史回填：把 R2 里归档的 chat_logs 灌进记忆。
 *
 * 为什么需要（2026-11-08 探针第 10 题）：D1 只保留今天和昨天，
 * 三天前的对话既不在 30 轮窗口、也不在 memory.md 里，问起来只能答"那个视频"。
 *
 * 一次只处理一天（一次模型调用 + 一次写记忆），可重复调用逐天补齐。
 */
import type { Env } from './types';
import { addDays, dateKeyInBeijing } from './date';
import { getObject } from './storage';
import { getMemory, putMemory } from './memory';
import { distillDay } from './distill';
import { buildDistillConversation } from './distill-view';
import { mergeMemoryEntry } from './memory-maintenance';
import { refreshChunksCacheFromMemory } from './memory-context-store';
import { getRuntimeState, putRuntimeState } from './runtime-store';
import { logError } from './error-log';

export const BACKFILL_FLAG_PREFIX = 'distill:backfill:';
export const BACKFILL_MAX_DAYS = 14;

interface ArchivedMessage {
  role?: string;
  content?: string;
  turn_type?: string | null;
  created_at?: string;
}

export async function readArchivedDay(env: Env, dateKey: string): Promise<ArchivedMessage[]> {
  const obj = await getObject(env, `chat_logs/${dateKey}.log`).catch(() => null);
  if (obj) {
    try {
      const parsed = JSON.parse(await obj.text()) as { messages?: ArchivedMessage[] };
      return parsed.messages ?? [];
    } catch {
      return [];
    }
  }
  const month = dateKey.slice(0, 7);
  const monthly = await getObject(env, `chat_logs/${month}.json`).catch(() => null);
  if (!monthly) return [];
  try {
    const parsed = JSON.parse(await monthly.text()) as { messages?: ArchivedMessage[] };
    return (parsed.messages ?? []).filter((m) => (m as { date_key?: string }).date_key === dateKey);
  } catch {
    return [];
  }
}

export async function backfillDay(env: Env, dateKey: string): Promise<{ ok: boolean; reason?: string }> {
  const flag = `${BACKFILL_FLAG_PREFIX}${dateKey}`;
  const done = await getRuntimeState(env, flag).catch(() => null);
  if (done) return { ok: true, reason: 'already' };

  const rows = await readArchivedDay(env, dateKey);
  if (rows.length === 0) {
    await putRuntimeState(env, flag, 'empty', 86400 * 60).catch(() => undefined);
    return { ok: false, reason: 'no_archive' };
  }

  const memory = await getMemory(env);
  const conversation = buildDistillConversation(
    rows
      .filter((r) => typeof r.content === 'string' && r.content.trim())
      .map((r) => ({
        role: r.role ?? 'user',
        content: String(r.content),
        turn_type: r.turn_type ?? undefined,
        created_at: r.created_at ?? `${dateKey}T12:00:00+08:00`,
      })) as never,
  );
  const summary = await distillDay(env, dateKey, conversation, memory, { fast: true });
  const text = summary.text?.trim() ?? '';
  if (!text) return { ok: false, reason: 'empty_distill' };

  const merged = mergeMemoryEntry(memory, text, dateKey, {});
  const saved = merged !== memory ? await putMemory(env, merged).catch(() => false) : true;
  if (!saved) return { ok: false, reason: 'write_failed' };
  await refreshChunksCacheFromMemory(env, merged).catch((e: unknown) =>
    logError('[backfill] chunk cache failed:', e),
  );
  await putRuntimeState(env, flag, 'done', 86400 * 90).catch(() => undefined);
  return { ok: true };
}

export async function backfillNextDay(
  env: Env,
  now: Date = new Date(),
): Promise<{ date: string | null; ok: boolean; reason?: string }> {
  const today = dateKeyInBeijing(now);
  for (let back = 1; back <= BACKFILL_MAX_DAYS; back += 1) {
    const day = addDays(today, -back);
    const flag = await getRuntimeState(env, `${BACKFILL_FLAG_PREFIX}${day}`).catch(() => null);
    if (flag) continue;
    const r = await backfillDay(env, day);
    return { date: day, ...r };
  }
  return { date: null, ok: true, reason: 'nothing_left' };
}
