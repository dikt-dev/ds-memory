/**
 * 增量提炼：白天每 30 分钟把新消息并进记忆，而不是等 04:00 一次性提炼。
 *
 * 为什么需要（2026-11-08 探针实测）：晚上聊的内容当天进不了长期记忆——
 * memory.md 要等次日 04:00，24h 纪要和话题标题只有粗粒度，
 * 30 轮原文一滑出窗口，就再也说不出细节（"那个二创视频"只能答成另一个视频）。
 *
 * 做法：和日归档同一套 distill → merge → reindex，只是把范围缩到"上次游标之后的新消息"。
 */
import type { Env } from './types';
import { dateKeyInBeijing } from './date';
import { getMemory, putMemory } from './memory';
import { distillDay } from './distill';
import { buildDistillConversation } from './distill-view';
import { mergeMemoryEntry } from './memory-maintenance';
import { refreshChunksCacheFromMemory } from './memory-context-store';
import { getRuntimeState, putRuntimeState } from './runtime-store';
import { logError } from './error-log';
import { collapseOngoing } from './memory-ongoing';
import { crossSectionPass } from './memory-compact';

/** 增量写入前的就地折叠：并掉同实体的多版本、跨分区去重、补锚点。全部纯函数。 */
function compactIncremental(memory: string): string {
  try {
    return crossSectionPass(collapseOngoing(memory).text).text;
  } catch {
    return memory;
  }
}

export const INC_CURSOR_KEY = 'distill:inc:cursor';
export const INC_LAST_RUN_KEY = 'distill:inc:at';
/** 两次增量提炼的最小间隔。 */
export const INC_MIN_GAP_MS = 30 * 60 * 1000;
/** 少于这么多条新消息就不值得跑一次模型。 */
export const INC_MIN_MESSAGES = 6;
export const INC_MAX_MESSAGES = 80;

interface IncRow {
  id: number;
  role: string;
  content: string;
  turn_type: string | null;
  created_at: string;
}

export async function incrementalDistill(env: Env, now: Date = new Date()): Promise<{ ok: boolean; added?: number; reason?: string }> {
  try {
    const lastRaw = await getRuntimeState(env, INC_LAST_RUN_KEY).catch(() => null);
    const lastAt = lastRaw ? Number(lastRaw) : 0;
    if (Number.isFinite(lastAt) && lastAt > 0 && now.getTime() - lastAt < INC_MIN_GAP_MS) {
      return { ok: false, reason: 'throttled' };
    }

    const cursorRaw = await getRuntimeState(env, INC_CURSOR_KEY).catch(() => null);
    const cursor = Number.isFinite(Number(cursorRaw)) ? Number(cursorRaw) : 0;

    const rows = await env.DB.prepare(
      'SELECT id, role, content, turn_type, created_at FROM messages WHERE id > ? ORDER BY id ASC LIMIT ?',
    )
      .bind(cursor, INC_MAX_MESSAGES)
      .all<IncRow>()
      .catch(() => null);
    const batch = rows?.results ?? [];
    if (batch.length < INC_MIN_MESSAGES) {
      await putRuntimeState(env, INC_LAST_RUN_KEY, String(now.getTime()), 3600).catch(() => undefined);
      return { ok: false, reason: 'too_few' };
    }

    const memory = await getMemory(env);
    const conversation = buildDistillConversation(
      batch.map((r) => ({
        role: r.role,
        content: r.content,
        turn_type: r.turn_type ?? undefined,
        created_at: r.created_at,
      })) as never,
    );
    const dateKey = dateKeyInBeijing(now);
    const summary = await distillDay(env, dateKey, conversation, memory, { fast: true });
    const text = summary.text?.trim() ?? '';

    let added = 0;
    if (text) {
      const merged = mergeMemoryEntry(memory, text, dateKey, {});
      // ★ 增量写入时顺手做一次折叠/去重（纯 JS，几毫秒）：
      //   白天每 30 分钟就会写一次记忆，如果只在次日凌晨折叠，
      //   同一件事的多版本会在当天一直存在（2026-11-08 实测 5 个版本）。
      const folded = compactIncremental(merged);
      if (folded !== memory) {
        const saved = await putMemory(env, folded).catch(() => false);
        if (saved) {
          added = 1;
          // ★ 只重建召回缓存，不跑全量 reindex：reindex 会给所有条目重算向量（实测 145s），
          //   而增量只需要新条目进召回；新条目 vec 留空也能被关键词召回命中。
          await refreshChunksCacheFromMemory(env, folded).catch((e: unknown) =>
            logError('[inc-distill] chunk cache failed:', e),
          );
        }
      }
    }

    const lastId = batch[batch.length - 1]?.id ?? cursor;
    await putRuntimeState(env, INC_CURSOR_KEY, String(lastId), 86400 * 30).catch(() => undefined);
    await putRuntimeState(env, INC_LAST_RUN_KEY, String(now.getTime()), 3600).catch(() => undefined);
    return { ok: Boolean(text), added };
  } catch (e) {
    logError('[inc-distill] failed:', e);
    return { ok: false, reason: 'exception' };
  }
}
