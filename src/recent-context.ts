/**
 * 跨天短期记忆：默认带最近 15 轮（turn_id 分组，按时间从旧到新）。
 *
 * - 默认 15 轮；技术/项目类 30 轮；明确指代前文时最多 50 轮；
 * - D1 不足时从 R2 的日归档 / 月归档补最近几轮；
 * - 只读归档，不写回 D1，也不改变归档数据。
 */
import type { Env } from './types';
import {
  groupTurns,
  recentRoundMessages,
  takeLastRounds,
  MAX_HISTORY_ROUNDS,
  type MessageRow,
} from './db';
import { addDays, dateKeyInBeijing } from './date';
import { getObject } from './storage';

/** 默认携带的最近轮数。一轮 = 用户消息 + 它的回复，或一条主动消息。 */
// 2026-11-09：30 轮里全是她自己的旧回复，模型会照着自己的句式写（围巾动作连用 6 条）。
// 18 轮仍然覆盖一次连续对话，但自我模仿的素材少了一半。
export const RECENT_ROUNDS = 18;
/** 单次请求的硬上限；只有明确“接着刚才/前面”才取 50。 */
export const MAX_RECENT_ROUNDS = MAX_HISTORY_ROUNDS;
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
 * - 默认 30 轮：15 轮只够覆盖半小时内的短句往来，「刚聊过的」常常已经掉出窗口（2026-11-07）
 * - 明确指代前文（“接着刚才/前面那个”）→ 60 轮；
 * - 长技术/项目/调试类消息 → 60 轮。
 */
export function resolveRecentRounds(text: string): number {
  const t = (text || '').trim();
  if (/(接着刚才|继续刚才|接着前面|继续前面|前面那个|上一条|回到刚才|接着上面|继续上面)/.test(t)) {
    return 60;
  }
  if (
    t.length > 80 ||
    /(代码|报错|debug|bug|调试|项目|实现|修复|部署|日志|函数|接口|数据库|记忆|归档)/i.test(t)
  ) {
    return 60;
  }
  return RECENT_ROUNDS;
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

/**
 * 历史的字符预算（≈ 9,600 tokens）。
 *
 * 原来只按轮数（120 轮）切，实测 76 轮就 11.5k tokens——轮数和体积脱钩。
 * 这里从最新往回按「整轮」累加，超预算就丢更早的轮，至少留一轮。
 */
export const HISTORY_BUDGET_CHARS = 12_000;

export interface HistorySlice {
  /** 注入用的原文（时间升序、整轮）。 */
  rows: MessageRow[];
  /** 没进原文那一段的提要；全都进了原文时是空串。 */
  brief: string;
  /** 本会话总轮数。 */
  rounds: number;
  /** 其中以原文形式注入的轮数。 */
  fullRounds: number;
}

export interface HistorySliceOptions {
  /** 原文最多带多少轮；更早的进提要。 */
  fullTurns?: number;
  /** 原文的字符预算；超了继续从旧往新挪进提要。 */
  maxChars?: number;
  briefMaxLines?: number;
  briefMaxChars?: number;
  briefHeader?: string;
}

/**
 * 会话历史切成「原文 + 提要」。
 *
 * 以前超限是直接从数组里删掉，模型不知道自己少了一段，于是"刚聊过的"凭空消失
 * （2026-11-09：11-08 那场 41 轮的会话，从第 32 轮起开头 11 轮就不在提示词里了）。
 * 现在被挤掉的轮次压成一行一条的提要，跟易变段一起注入，一段会话始终接得上。
 */
export function buildHistorySlice(
  rows: MessageRow[],
  opts: HistorySliceOptions = {},
): HistorySlice {
  const fullTurns = Math.max(1, Math.floor(opts.fullTurns ?? CHAT_FULL_TURNS));
  const maxChars = Math.max(0, Math.floor(opts.maxChars ?? HISTORY_BUDGET_CHARS));
  const turns = groupTurns(rows);
  if (turns.length === 0) return { rows: [], brief: "", rounds: 0, fullRounds: 0 };
  const older = turns.slice(0, Math.max(0, turns.length - fullTurns));
  const tail = turns.slice(older.length);
  let used = 0;
  let keepFrom = tail.length;
  for (let i = tail.length - 1; i >= 0; i -= 1) {
    const size = tail[i].reduce((sum, m) => sum + (m.content?.length ?? 0), 0);
    // 至少留一轮：最后一轮再大也带
    if (keepFrom < tail.length && used + size > maxChars) break;
    used += size;
    keepFrom = i;
  }
  const dropped = [...older, ...tail.slice(0, keepFrom)].flat();
  const kept = tail.slice(keepFrom).flat();
  const brief =
    dropped.length === 0
      ? ""
      : buildSessionDigest(dropped, {
          maxLines: opts.briefMaxLines ?? BRIEF_MAX_LINES,
          maxChars: opts.briefMaxChars ?? BRIEF_MAX_CHARS,
          header: opts.briefHeader ?? CHAT_BRIEF_HEADER,
        });
  return { rows: kept, brief, rounds: turns.length, fullRounds: tail.length - keepFrom };
}

/** 只要原文、不要提要的旧接口（保留给其它调用点与测试）。 */
export function trimHistoryToBudget(rows: MessageRow[], maxChars = HISTORY_BUDGET_CHARS): MessageRow[] {
  return buildHistorySlice(rows, { fullTurns: Number.MAX_SAFE_INTEGER, maxChars }).rows;
}

export interface SessionHistory {
  /** 整段会话的消息（时间升序，还没按体积切）。 */
  rows: MessageRow[];
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

export interface SessionDigestOptions {
  maxLines?: number;
  maxChars?: number;
  /** 头一行；{n} 会替换成轮数。传空串表示只要条目。 */
  header?: string;
}

const DIGEST_HEADER = "## 本会话更早的（提要，原文已不在上下文）";

/**
 * 把「原文进不了上下文」的那段压成提要（确定性函数：不调模型、不落库）。
 * 均匀抽样到最多 maxLines 行，越长抽样越稀，字数可控。
 */
export function buildSessionDigest(
  rows: MessageRow[],
  opts: SessionDigestOptions = {},
): string {
  const maxLines = Math.max(1, Math.floor(opts.maxLines ?? 12));
  const maxChars = Math.max(0, Math.floor(opts.maxChars ?? 700));
  const header = opts.header ?? DIGEST_HEADER;
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
  const head = header ? header.replace("{n}", String(turns.length)) + "\n" : "";
  const text = head + lines.join("\n");
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

/** 旧名保留：兜底场景（会话超长）用的默认参数。 */
export function buildSessionBrief(rows: MessageRow[], maxLines = 12, maxChars = 700): string {
  return buildSessionDigest(rows, { maxLines, maxChars });
}

/**
 * 一场会话里「原文」给多少轮。
 *
 * 不往上加了：30 轮已经能让模型照着她自己的句式写（2026-11-09 围巾动作连用 6 条）。
 * 更早的轮次用提要补上——她要的是"刚才聊过什么"，不是逐字复读她自己。
 */
export const CHAT_FULL_TURNS = 30;
/** 提要最多多少行（一场 200 轮的会话也只有这么多）。 */
export const BRIEF_MAX_LINES = 40;
/** 提要的字符上限。 */
export const BRIEF_MAX_CHARS = 1_400;
/** 聊天链路的提要抬头：让她明确这是提要、不是原话。 */
export const CHAT_BRIEF_HEADER = "【本会话更早的（原文已不在上下文，只有提要）】共 {n} 轮：";

/**
 * 会话级短期记忆：同一段会话里只追加、不滑窗——这是前缀缓存能命中的前提。
 *
 * 这里只负责「切出这段会话」，「切成原文+提要」交给 buildHistorySlice：
 * 它必须先去掉本轮刚写进 D1 的那条用户消息，轮数才不会多算一轮。
 */
export async function loadSessionHistory(env: Env, now: Date = new Date()): Promise<SessionHistory> {
  const fetched = await recentRoundMessages(env, MAX_RECENT_ROUNDS);
  const sessionRows = sliceCurrentSession(fetched);
  return { rows: sessionRows, rounds: groupTurns(sessionRows).length };
}