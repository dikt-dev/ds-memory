/**
 * 跨天短期记忆：默认带最近 10 轮（turn_id 分组，按时间从旧到新）。
 *
 * - 优先从 D1 取最近 10 轮；
 * - D1 不足 10 轮时（新的一天刚开始，或旧消息已被月度清理），
 *   从 R2 的昨天日归档 / 月归档补最后几轮；
 * - 只读归档，不写回 D1，也不改变归档数据。
 */
import type { Env } from './types';
import { groupTurns, recentRoundMessages, takeLastRounds, type MessageRow } from './db';
import { dateKeyInBeijing, previousDateKey } from './date';
import { getObject } from './storage';

/** 默认携带的最近轮数。一轮 = 用户消息 + 它的回复，或一条主动消息。 */
export const RECENT_ROUNDS = 10;

const compareMessages = (a: MessageRow, b: MessageRow) =>
  a.created_ms - b.created_ms || a.id - b.id;

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

/**
 * 最近 N 轮完整消息（时间升序）。
 *
 * 返回的是「整轮」：不会把用户消息和它的回复拆开；
 * 主动消息自成一轮。调用方按时间顺序注入，即可让模型明确
 * 「最后一条历史是上一句，再往前是上上句」。
 */
export async function loadRecentRounds(
  env: Env,
  rounds = RECENT_ROUNDS,
  now: Date = new Date(),
): Promise<MessageRow[]> {
  const n = Math.max(1, Math.min(Math.floor(rounds), 30));
  const rows = await recentRoundMessages(env, n);
  if (groupTurns(rows).length >= n) return rows;

  const prev = previousDateKey(dateKeyInBeijing(now));
  // 多取一些原始消息，保证跨天时仍能凑出 n 轮
  const tail = await loadDayTail(env, prev, n * 2 + 4);
  if (tail.length === 0) return rows;

  const merged = [...tail, ...rows].sort(compareMessages);
  return takeLastRounds(merged, n);
}

/**
 * 兼容旧调用：按“消息条数”估算轮数。
 * 新代码请直接用 loadRecentRounds。
 */
export async function loadRecentHistory(
  env: Env,
  limit: number,
  now: Date,
): Promise<MessageRow[]> {
  return loadRecentRounds(env, Math.max(1, Math.ceil(limit / 2)), now);
}
