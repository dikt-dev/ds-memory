/**
 * R2 聊天归档回灌。
 *
 * D1 只保留今天/昨天，旧消息在：
 * - chat_logs/YYYY-MM-DD.log（日归档）
 * - chat_logs/YYYY-MM.json（月度合并后，日文件会被删除）
 *
 * App 的 /api/app/events 翻到 D1 边界时，用这里读取更早的归档，
 * 从而让重装/换机后的客户端也能继续向上翻完整历史。
 */
import type { Env } from './types';
import type { MessageRow } from './db';
import { getObject } from './storage';

interface ArchivedLog {
  date?: string;
  month?: string;
  messages?: MessageRow[];
}

function dailyDateFromKey(key: string): string | null {
  const m = /^chat_logs\/(\d{4}-\d{2}-\d{2})\.log$/.exec(key);
  return m ? m[1] : null;
}

function monthFromKey(key: string): string | null {
  const m = /^chat_logs\/(\d{4}-\d{2})\.json$/.exec(key);
  return m ? m[1] : null;
}

interface ArchiveSource {
  key: string;
  /** 用于从新到旧扫描的排序键 */
  sortKey: string;
}

export interface ArchivedPage {
  messages: MessageRow[];
  hasMore: boolean;
}

/**
 * 读取 id < beforeId 的归档消息，按 id 升序返回最后 limit 条。
 * 同时支持日归档和月归档；按从新到旧扫描，收集到 limit+1 条即可停止。
 */
export async function archivedMessagesBefore(
  env: Env,
  beforeId: number,
  limit: number,
): Promise<ArchivedPage> {
  if (beforeId <= 0 || limit <= 0) return { messages: [], hasMore: false };

  let sources: ArchiveSource[] = [];
  try {
    const listed = await env.R2.list({ prefix: 'chat_logs/', limit: 1000 });
    sources = (listed.objects ?? [])
      .map((o): ArchiveSource | null => {
        const daily = dailyDateFromKey(o.key);
        if (daily) return { key: o.key, sortKey: daily };
        const month = monthFromKey(o.key);
        // 月文件排在同月所有日文件之后；有日文件时月文件会由 id 去重。
        if (month) return { key: o.key, sortKey: `${month}-32` };
        return null;
      })
      .filter((s): s is ArchiveSource => Boolean(s))
      .sort((a, b) => b.sortKey.localeCompare(a.sortKey));
  } catch (e) {
    console.error('[archive] list failed:', e);
    return { messages: [], hasMore: false };
  }

  // 按月归档读取时可能和日归档重叠，用 id 去重。
  const byId = new Map<number, MessageRow>();
  for (const source of sources) {
    const obj = await getObject(env, source.key);
    if (!obj) continue;
    let parsed: ArchivedLog;
    try {
      parsed = JSON.parse(await obj.text()) as ArchivedLog;
    } catch {
      continue;
    }
    const rows = Array.isArray(parsed.messages) ? parsed.messages : [];
    for (const row of rows) {
      if (
        row &&
        typeof row.id === 'number' &&
        row.id < beforeId &&
        !byId.has(row.id)
      ) {
        byId.set(row.id, row);
      }
    }
    if (byId.size >= limit + 1) break;
  }

  const collected = [...byId.values()].sort((a, b) => a.id - b.id);
  // 恰好取满 limit 时也返回 hasMore=true，让客户端再请求一次边界确认；
  // 否则可能恰好漏掉更早归档里的第一条。
  const hasMore = collected.length >= limit;
  return {
    messages: collected.slice(-limit),
    hasMore,
  };
}
