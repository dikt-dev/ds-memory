/**
 * R2 聊天归档回灌。
 *
 * D1 只保留今天/昨天，旧消息在 chat_logs/YYYY-MM-DD.log。
 * App 的 /api/app/events 翻到 D1 边界时，用这里读取更早的归档，
 * 从而让重装/换机后的客户端也能继续向上翻完整历史。
 */
import type { Env } from './types';
import type { MessageRow } from './db';
import { getObject } from './storage';

interface ArchivedLog {
  date?: string;
  messages?: MessageRow[];
}

function dateFromKey(key: string): string | null {
  const m = /^chat_logs\/(\d{4}-\d{2}-\d{2})\.log$/.exec(key);
  return m ? m[1] : null;
}

export interface ArchivedPage {
  messages: MessageRow[];
  hasMore: boolean;
}

/**
 * 读取 id < beforeId 的归档消息，按 id 升序返回最后 limit 条。
 * 归档按日期从新到旧扫描，收集到 limit+1 条即可停止。
 */
export async function archivedMessagesBefore(
  env: Env,
  beforeId: number,
  limit: number,
): Promise<ArchivedPage> {
  if (beforeId <= 0 || limit <= 0) return { messages: [], hasMore: false };

  let dates: string[] = [];
  try {
    const listed = await env.R2.list({ prefix: 'chat_logs/', limit: 1000 });
    dates = (listed.objects ?? [])
      .map((o) => dateFromKey(o.key))
      .filter((d): d is string => Boolean(d))
      .sort()
      .reverse();
  } catch (e) {
    console.error('[archive] list failed:', e);
    return { messages: [], hasMore: false };
  }

  const collected: MessageRow[] = [];
  for (const date of dates) {
    const obj = await getObject(env, `chat_logs/${date}.log`);
    if (!obj) continue;
    let parsed: ArchivedLog;
    try {
      parsed = JSON.parse(await obj.text()) as ArchivedLog;
    } catch {
      continue;
    }
    const rows = Array.isArray(parsed.messages) ? parsed.messages : [];
    for (const row of rows) {
      if (row && typeof row.id === 'number' && row.id < beforeId) collected.push(row);
    }
    if (collected.length >= limit + 1) break;
  }

  collected.sort((a, b) => a.id - b.id);
  // 恰好取满 limit 时也返回 hasMore=true，让客户端再请求一次边界确认；
  // 否则可能恰好漏掉更早归档里的第一条。
  const hasMore = collected.length >= limit;
  return {
    messages: collected.slice(-limit),
    hasMore,
  };
}
