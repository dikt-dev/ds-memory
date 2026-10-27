/**
 * 跨天短期记忆：默认带最近 15 轮（turn_id 分组，按时间从旧到新）。
 *
 * - 默认 15 轮；技术/项目类 30 轮；明确指代前文时最多 50 轮；
 * - D1 不足时从 R2 的日归档 / 月归档补最近几轮；
 * - 只读归档，不写回 D1，也不改变归档数据。
 */
import type { Env } from './types';
import { groupTurns, recentRoundMessages, takeLastRounds, type MessageRow } from './db';
import { addDays, dateKeyInBeijing } from './date';
import { getObject } from './storage';

/** 默认携带的最近轮数。一轮 = 用户消息 + 它的回复，或一条主动消息。 */
export const RECENT_ROUNDS = 15;
/** 单次请求的硬上限；只有明确“接着刚才/前面”才取 50。 */
export const MAX_RECENT_ROUNDS = 60;
/** 主动消息不需要占用聊天级的长历史。 */
export const PROACTIVE_RECENT_ROUNDS = 10;

/**
 * 自适应短期记忆：
 * - 默认 15 轮；
 * - 明确指代前文（“接着刚才/前面那个”）→ 50 轮；
 * - 长技术/项目/调试类消息 → 30 轮。
 */
export function resolveRecentRounds(text: string): number {
  const t = (text || '').trim();
  if (/(接着刚才|继续刚才|接着前面|继续前面|前面那个|上一条|回到刚才|接着上面|继续上面)/.test(t)) {
    return 50;
  }
  if (
    t.length > 80 ||
    /(代码|报错|debug|bug|调试|项目|实现|修复|部署|日志|函数|接口|数据库|记忆|归档)/i.test(t)
  ) {
    return 30;
  }
  return 15;
}

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
  const n = Math.max(1, Math.min(Math.floor(rounds), MAX_RECENT_ROUNDS));
  const rows = await recentRoundMessages(env, n);
  let merged = rows;
  const today = dateKeyInBeijing(now);
  // 50 轮可能跨两三天；最多向前补 3 天，避免长对话被截断。
  for (let back = 1; back <= 3 && groupTurns(merged).length < n; back++) {
    const tail = await loadDayTail(env, addDays(today, -back), n * 2 + 4);
    if (tail.length === 0) continue;
    merged = [...tail, ...merged].sort(compareMessages);
  }
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
