/**
 * 跨天短期记忆：优先用 D1 最近 12 条；如果一天刚开始、D1 里还没有足够的
 * “昨天”消息（或已被月度清理），就从 R2 的日/月归档里补最后几条。
 *
 * 目的：第二天前几句话也要接得上昨天，而不是因为归档就断片。
 * 只读归档，不写回 D1，也不改变归档数据。
 */
import type { Env } from './types';
import { type MessageRow, recentMessages } from './db';
import { dateKeyInBeijing, previousDateKey } from './date';
import { getObject } from './storage';

const YDAY_MIN = 4; // 至少补到 4 条昨天的消息

async function loadDayTail(env: Env, dateKey: string, limit: number): Promise<MessageRow[]> {
  const dailyKey = `chat_logs/${dateKey}.log`;
  const daily = await getObject(env, dailyKey).catch(() => null);
  if (daily) {
    try {
      const parsed = JSON.parse(await daily.text()) as { messages?: MessageRow[] };
      return (parsed.messages ?? []).slice(-limit);
    } catch {
      /* 继续尝试月度归档 */
    }
  }
  // 月末合并后单日 .log 会被删除，回退到月文件
  const month = dateKey.slice(0, 7);
  const monthly = await getObject(env, `chat_logs/${month}.json`).catch(() => null);
  if (!monthly) return [];
  try {
    const parsed = JSON.parse(await monthly.text()) as { messages?: MessageRow[] };
    return (parsed.messages ?? []).filter((m) => m.date_key === dateKey).slice(-limit);
  } catch {
    return [];
  }
}

/** 最近 N 条短期记忆（保证尽量带上昨天的最后几条）。 */
export async function loadRecentHistory(
  env: Env,
  limit: number,
  now: Date,
): Promise<MessageRow[]> {
  const rows = await recentMessages(env, limit);
  const prev = previousDateKey(dateKeyInBeijing(now));
  const yesterdayCount = rows.filter((r) => r.date_key === prev).length;
  if (yesterdayCount >= YDAY_MIN) return rows;

  const tail = await loadDayTail(env, prev, limit);
  if (tail.length === 0) return rows;

  const have = new Set(rows.map((r) => r.id));
  const extra = tail.filter((m) => !have.has(m.id));
  if (extra.length === 0) return rows;

  // 早上 4 条以上昨天的消息 + 现在的消息；按 id 排序后保留最近 limit 条
  return [...extra, ...rows].sort((a, b) => a.id - b.id).slice(-limit);
}
