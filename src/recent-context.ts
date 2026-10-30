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

/** 给模型一条“距上次对话”的提示，不写入消息正文。 */
export function conversationGapNote(history: MessageRow[], now: Date): string {
  const last = history[history.length - 1];
  if (!last) return '【距上次对话】这是你们第一次对话。';
  const gapMs = Math.max(0, now.getTime() - last.created_ms);
  const minutes = Math.floor(gapMs / 60_000);
  let gap: string;
  if (minutes < 1) gap = '不到 1 分钟';
  else if (minutes < 60) gap = `约 ${minutes} 分钟`;
  else if (minutes < 24 * 60) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    gap = `约 ${h} 小时${m > 0 ? ` ${m} 分钟` : ''}`;
  } else {
    const d = Math.floor(minutes / (24 * 60));
    const h = Math.floor((minutes % (24 * 60)) / 60);
    gap = `约 ${d} 天${h > 0 ? ` ${h} 小时` : ''}`;
  }
  return `【距上次对话】${gap}（上次消息：${last.created_at}）。`;
}

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

/** 会话边界：距上一条消息超过 6 小时就算新会话。 */
export const SESSION_GAP_MS = 6 * 60 * 60 * 1000;
/** 一次最多往回取多少轮（只为找会话起点，不直接注入）。 */
export const SESSION_FETCH_ROUNDS = 200;
/** 单会话注入硬上限；超了才启用提要（缓存会断，但属极端情况）。 */
export const SESSION_MAX_ROUNDS = 120;
/** 超限时保留的尾部轮数。 */
export const SESSION_KEEP_ROUNDS = 40;

export interface SessionHistory {
  /** 注入用的历史消息（时间升序）。 */
  rows: MessageRow[];
  /** 被压掉那段的提要；没有超限时为空串。 */
  brief: string;
  /** 本会话总轮数。 */
  rounds: number;
}

/** 从最近一次长间隔之后切出当前会话；没有长间隔就返回全部。 */
export function sliceCurrentSession(rows: MessageRow[]): MessageRow[] {
  let start = 0;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].created_ms - rows[i - 1].created_ms > SESSION_GAP_MS) start = i;
  }
  return rows.slice(start);
}

function shortClock(createdAt: string): string {
  const m = /(\d{2}:\d{2})/.exec(createdAt || "");
  return m ? m[1] : "";
}

/**
 * 把被挤出去的那段压成提要（确定性函数：不调模型、不落库）。
 * 均匀抽样到最多 maxLines 行，越长抽样越稀，字数可控。
 */
export function buildSessionBrief(rows: MessageRow[], maxLines = 12, maxChars = 700): string {
  const turns = groupTurns(rows);
  if (turns.length === 0) return "";
  const step = Math.max(1, Math.ceil(turns.length / maxLines));
  const picked = turns.filter((_, i) => i % step === 0).slice(0, maxLines);
  const lines = picked.map((turn) => {
    const user = turn.find((m) => m.role === "user");
    const bot = turn.find((m) => m.role !== "user");
    const u = (user?.content ?? "").replace(/\s+/g, " ").slice(0, 28);
    const b = (bot?.content ?? "").replace(/\s+/g, " ").slice(0, 20);
    const clock = shortClock((user?.created_at ?? bot?.created_at) || "");
    return "- " + clock + " " + u + (b ? " → " + b : "");
  });
  const text = "## 本会话更早的（提要，原文已不在上下文）\n" + lines.join("\n");
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

/**
 * 会话级短期记忆：同一段会话里只追加、不滑窗——这是前缀缓存能命中的前提。
 * 只有超过 SESSION_MAX_ROUNDS 才退化成「提要 + 尾部原文」。
 */
export async function loadSessionHistory(env: Env, now: Date = new Date()): Promise<SessionHistory> {
  const fetched = await recentRoundMessages(env, SESSION_FETCH_ROUNDS);
  const sessionRows = sliceCurrentSession(fetched);
  const turns = groupTurns(sessionRows);
  if (turns.length <= SESSION_MAX_ROUNDS) {
    return { rows: sessionRows, brief: "", rounds: turns.length };
  }
  const dropped = turns.slice(0, turns.length - SESSION_KEEP_ROUNDS).flat();
  const kept = turns.slice(-SESSION_KEEP_ROUNDS).flat();
  return { rows: kept, brief: buildSessionBrief(dropped), rounds: turns.length };
}
