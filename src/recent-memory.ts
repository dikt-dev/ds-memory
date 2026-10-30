/**
 * 中期记忆：最近 24 小时的滚动事实纪要。
 *
 * 为什么需要这一层：
 * - 长期记忆（memory.md）每天 04:00 才更新一次，体现不了「最近一天」；
 * - 今日摘要按自然日重置，跨零点就断片；
 * - 原始消息只有最近 20 条，聊多一点就看不到昨天半夜说的那件事。
 *
 * 三层记忆的分工：
 *   长期 = memory.md（稳定事实，每天提炼）
 *   中期 = memo:24h（最近一天发生了什么，滚动、条目化）
 *   短期 = D1 会话内原文
 *
 * 2026-10-30 改版（四条一起）：
 *   O1 容量：5~8 条 ×24 字 → 12~16 条 ×40 字，每条带时间锚；
 *   O2 写入：全量重写 → 只追加新条目，旧条目原文不再变（记性不稳的根因）；
 *   O3 输入：全量对话 → 规则先抽关键句，模型只负责压缩；
 *   O4 注入：落在当前会话时间范围内的条目不重复注入（历史原文里已经有）。
 */
import type { Env } from './types';
import { distillText } from './distill';
import { addLlmCost } from './llm-cost';
import { dateKeyInBeijing } from './date';
import { acquireRuntimeLock, getRuntimeState, putRuntimeState, releaseRuntimeLock } from './runtime-store';

/** 新格式（条目数组）；旧 key 只读，用于一次性迁移。 */
const MEMO_KV = 'memo:24h:v2';
const LEGACY_MEMO_KV = 'memo:24h';
const LOCK_KV = 'memo:lock';
const LOCK_TTL_SECONDS = 120;
/** 96 小时过期：留一天余量，隔两天没说话纪要也不会立刻消失 */
const MEMO_TTL_SECONDS = 96 * 60 * 60;

/** 纪要覆盖的时间窗口：3 天（原来 24 小时，隔一天就断片）。 */
export const MEMO_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
/** 新增消息达到这个数就刷新一次。 */
export const MEMO_REFRESH_MESSAGES = 15;
/** 或者距上次刷新超过这个时长（3 小时）。 */
export const MEMO_REFRESH_MS = 3 * 60 * 60 * 1000;
/** 注入提示词时最多保留几条。 */
export const MEMO_MAX_ITEMS = 24;
/** 增量太少（比如刚说了一句「在吗」）不值得花一次模型调用。 */
export const MEMO_MIN_NEW_MESSAGES = 4;
/** 单次最多读多少条原始消息，防止一天聊爆时把整张表拉回来。 */
export const MEMO_MAX_SOURCE_MESSAGES = 300;
/** 喂给模型的对话上限（字符），超出时保留最新的部分。 */
export const MEMO_INPUT_MAX_CHARS = 12000;
/** 条目总上限：超过时丢最旧的（写进 KV 时就裁，不只是渲染时裁）。 */
export const MEMO_MAX_STORED_ITEMS = 48;

export interface MemoItem {
  /** 发生时间（ISO） */
  at: string;
  /** 一句话事实 */
  text: string;
  /** 被新事实取代的旧条目：保留原文，只是不再注入 */
  superseded?: boolean;
}

export interface RecentMemo {
  items: MemoItem[];
  /** 已覆盖到的最大消息 id（增量判断用） */
  up_to_id: number;
  /** ISO 时间 */
  updated_at: string;
}

export interface MemoRow {
  role: string;
  turn_type: string;
  content: string;
  created_ms?: number;
}
/** 是否需要刷新（纯函数，可单测）。 */
export function shouldRefreshRecentMemo(args: { newMessages: number; ageMs: number }): boolean {
  if (args.newMessages >= MEMO_REFRESH_MESSAGES) return true;
  return args.ageMs >= MEMO_REFRESH_MS;
}

/**
 * 增量是否足够（纯函数）。
 * 表被清空/重建（resetDetected）时必须强制重算——此时 up_to_id 已经失效。
 */
export function hasEnoughNewMaterial(newMessages: number, resetDetected: boolean): boolean {
  if (resetDetected) return true;
  return newMessages >= MEMO_MIN_NEW_MESSAGES;
}

function normalizeItem(raw: unknown): MemoItem | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Partial<MemoItem>;
  const text = typeof obj.text === "string" ? obj.text.trim() : "";
  if (!text) return null;
  return {
    at: typeof obj.at === "string" ? obj.at : new Date().toISOString(),
    text,
    ...(obj.superseded ? { superseded: true } : {}),
  };
}

/** 旧格式（一整段 "- " 列表）拆成条目：没有时间锚，统一落到 updated_at。 */
export function parseLegacyMemo(raw: string | null, updatedAt: string): MemoItem[] {
  if (!raw) return [];
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("- "))
    .map((l) => ({ at: updatedAt, text: l.slice(2).trim(), }))
    .filter((i) => i.text.length > 0);
}

/** 读取当前中期记忆（新格式优先；旧格式惰性迁移，不写回）。 */
export async function getRecentMemo(env: Env): Promise<RecentMemo | null> {
  try {
    const raw = await getRuntimeState(env, MEMO_KV);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<RecentMemo>;
      const items = (parsed.items ?? []).map(normalizeItem).filter((i): i is MemoItem => i !== null);
      if (items.length === 0) return null;
      return {
        items,
        up_to_id: Number(parsed.up_to_id ?? 0),
        updated_at: typeof parsed.updated_at === "string" ? parsed.updated_at : new Date().toISOString(),
      };
    }
    // 旧格式迁移：只读不写，下一次刷新会写成新格式
    const legacy = await getRuntimeState(env, LEGACY_MEMO_KV);
    if (!legacy) return null;
    const parsed = JSON.parse(legacy) as { text?: string; up_to_id?: number; updated_at?: string };
    const updatedAt = typeof parsed.updated_at === "string" ? parsed.updated_at : new Date().toISOString();
    const items = parseLegacyMemo(parsed.text ?? null, updatedAt);
    if (items.length === 0) return null;
    return { items, up_to_id: Number(parsed.up_to_id ?? 0), updated_at: updatedAt };
  } catch {
    return null;
  }
}

function clockOf(iso: string): string {
  const m = /(\d{2}):(\d{2})/.exec(iso.slice(11, 19));
  const day = iso.slice(5, 10).replace("-", "/");
  return m ? day + " " + m[1] + ":" + m[2] : "";
}

/**
 * 渲染成提示词里的一块（纯函数）。
 * notBeforeMs：落在当前会话时间范围内的条目不注入——历史原文里已经有了。
 */
export function formatRecentMemoBlock(
  memo: RecentMemo | null,
  maxItems = MEMO_MAX_ITEMS,
  notBeforeMs?: number,
): string {
  if (!memo) return "";
  const items = memo.items
    .filter((i) => !i.superseded)
    .filter((i) => {
      if (!notBeforeMs) return true;
      const at = Date.parse(i.at);
      return !Number.isFinite(at) || at < notBeforeMs;
    })
    .slice(-maxItems);
  if (items.length === 0) return "";
  const lines = items.map((i) => {
    const clock = clockOf(i.at);
    return "- " + (clock ? "[" + clock + "] " : "") + i.text;
  });
  return ["## 最近三天（中期记忆）", ...lines].join("\n");
}

/**
 * O3：先用规则从新增对话里挑出「之后可能被提到」的句子，再交给模型压缩。
 * 挑不出来就退回最近若干行，保证模型不会没材料可用。
 */
const KEY_LINE_RE = /(决定|打算|准备|约定|答应|说好|改|换|开始|完成|截至|deadline|明天|后天|下周|月底|周五|周[一二三四六日]|报错|失败|卡住|难受|焦虑|累|失眠|生病|面试|请假|搬家|辞职|体检|生日|纪念|答应过|说过要)/;
export function pickKeyLines(rows: MemoRow[], maxLines = 60): MemoRow[] {
  const picked = rows.filter((r) => KEY_LINE_RE.test(r.content) && r.content.trim().length > 2);
  if (picked.length >= 3) return picked.slice(-maxLines);
  return rows.slice(-Math.min(rows.length, 30));
}

/**
 * 构造给模型的输入（纯函数）：旧纪要 + 新增关键行。
 */
export function buildMemoInput(prev: RecentMemo | null, rows: MemoRow[]): string {
  const picked = pickKeyLines(rows);
  const lines = picked.map((m) => {
    if (m.role === "user") return "用户：" + m.content;
    return m.turn_type === "proactive" ? "助手（主动发起）：" + m.content : "助手：" + m.content;
  });
  let conversation = lines.join("\n");
  if (conversation.length > MEMO_INPUT_MAX_CHARS) {
    conversation = conversation.slice(-MEMO_INPUT_MAX_CHARS);
  }
  const head = prev && prev.items.length > 0
    ? "【当前纪要】\n" + prev.items.filter((i) => !i.superseded).map((i) => "- " + i.text).join("\n") + "\n\n"
    : "";
  return head + "【新增对话】\n" + (conversation || "（无）");
}

/** 解析模型输出：每条一行，允许带 [MM/DD HH:mm] 时间锚。 */
export function parseMemoItems(
  text: string,
  fallbackAt: string,
  maxItems = MEMO_MAX_ITEMS,
): MemoItem[] {
  const out: MemoItem[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("- ")) continue;
    const body = line.slice(2).trim();
    if (!body) continue;
    const m = /^\[(\d{2}\/\d{2} \d{2}:\d{2})\]\s*(.+)$/.exec(body);
    out.push({
      at: m ? anchorToIso(m[1], fallbackAt) : fallbackAt,
      text: m ? m[2].trim() : body,
    });
  }
  return out.slice(-maxItems);
}

function anchorToIso(anchor: string, fallbackIso: string): string {
  const m = /^(\d{2})\/(\d{2}) (\d{2}):(\d{2})$/.exec(anchor);
  if (!m) return fallbackIso;
  const year = fallbackIso.slice(0, 4);
  return year + "-" + m[1] + "-" + m[2] + "T" + m[3] + ":" + m[4] + ":00+08:00";
}

/**
 * O2：把新条目并进旧条目。
 * - 旧条目原文永不改写；
 * - 新条目与旧条目高度重合时不重复添加；
 * - 总数超上限时丢最旧的。
 */
export function mergeMemoItems(
  prev: MemoItem[],
  added: MemoItem[],
  maxItems = MEMO_MAX_STORED_ITEMS,
  windowStartMs?: number,
): MemoItem[] {
  const merged = [...prev];
  for (const item of added) {
    const dup = merged.some((old) => old.text === item.text || old.text.includes(item.text) || item.text.includes(old.text));
    if (!dup) merged.push(item);
  }
  merged.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  // 超出覆盖窗口的条目丢掉：3 天滚动，不是无限堆积
  const inWindow = windowStartMs
    ? merged.filter((i) => {
        const at = Date.parse(i.at);
        return !Number.isFinite(at) || at >= windowStartMs;
      })
    : merged;
  return inWindow.slice(-maxItems);
}

const MEMO_SYSTEM = [
  "你负责维护一份「最近三天」的中期记忆纪要。",
  "你会看到【当前纪要】（可能为空）和【新增对话】。",
  "只输出**新增**的条目：1~3 条，每条一行，格式固定为： - [MM/DD HH:mm] 内容",
  "内容 40 字以内，电报体，按发生时间先后排列，最近的在最后。",
  "只写之后可能被提到的事：正在做的事、情绪变化、约定、决定、遇到的问题、身体状态。",
  "不写寒暄、不复述助手已经回应过的话、不写可推断的事实（时间/天气）。",
  "绝对不记录助手自己的报时、时间猜测、天气/节假日判断；这些以系统实时信息为准，记了会污染后续对话。",
  "【当前纪要】里已有的信息不要再输出一遍。",
  "没有值得新增的内容就输出空。",
].join("\n");

/**
 * 按需刷新中期记忆（节流 + 锁，可安全重复调用）。
 * 由聊天请求异步触发（waitUntil），失败不影响聊天。
 */
export async function maybeRefreshRecentMemo(env: Env, now: Date = new Date()): Promise<void> {
  try {
    const prev = await getRecentMemo(env);
    const since = now.getTime() - MEMO_WINDOW_MS;

    const latest = await env.DB.prepare("SELECT id FROM messages ORDER BY id DESC LIMIT 1").first<{
      id: number;
    }>();
    if (!latest) return;

    // 消息表被清空/重建后 id 会回退：旧 memo 的 up_to_id 失效，必须全量重来
    const resetDetected = prev !== null && latest.id < prev.up_to_id;
    const sinceId = resetDetected ? 0 : (prev?.up_to_id ?? 0);

    const counted = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM messages WHERE created_ms >= ? AND id > ?",
    )
      .bind(since, sinceId)
      .first<{ c: number }>();
    const newMessages = counted?.c ?? 0;
    const ageMs = prev ? now.getTime() - new Date(prev.updated_at).getTime() : Number.POSITIVE_INFINITY;

    if (!shouldRefreshRecentMemo({ newMessages, ageMs })) return;
    if (!hasEnoughNewMaterial(newMessages, resetDetected)) return;

    // ★ 便宜的判断通过后再加锁；D1 原子 UPSERT，无 D1 时回退 KV。
    if (!(await acquireRuntimeLock(env, LOCK_KV, LOCK_TTL_SECONDS))) return;

    try {
      // 增量：只取新消息；冷启动或表重置：取 24h 内最近的 N 条
      const query =
        resetDetected || !prev
          ? env.DB.prepare(
              "SELECT role, turn_type, content, created_ms FROM messages WHERE created_ms >= ? ORDER BY id DESC LIMIT ?",
            ).bind(since, MEMO_MAX_SOURCE_MESSAGES)
          : env.DB.prepare(
              "SELECT role, turn_type, content, created_ms FROM messages WHERE created_ms >= ? AND id > ? ORDER BY id DESC LIMIT ?",
            ).bind(since, sinceId, MEMO_MAX_SOURCE_MESSAGES);

      const rows = await query.all<MemoRow>();
      const ordered = [...(rows.results ?? [])].reverse(); // 取的是最新 N 条，翻回时间正序
      if (ordered.length === 0) return;

      // 表重置时不要把旧纪要带进去（它描述的是已经不存在的历史）
      const input = buildMemoInput(resetDetected ? null : prev, ordered);
      const result = await distillText(
        env,
        MEMO_SYSTEM,
        input,
        400,
        env.SUMMARY_DEEPSEEK_MODEL || env.DEEPSEEK_MODEL,
      );

      const added = parseMemoItems(result.text, now.toISOString());
      const items = mergeMemoItems(
        resetDetected ? [] : (prev?.items ?? []),
        added,
        MEMO_MAX_STORED_ITEMS,
        since,
      );
      if (items.length === 0) return;

      await putRuntimeState(
        env,
        MEMO_KV,
        JSON.stringify({ items, up_to_id: latest.id, updated_at: now.toISOString() }),
        MEMO_TTL_SECONDS,
      );
      // 摘要类调用也要计入当天费用（否则 /api/usage 会低估）
      await addLlmCost(env, dateKeyInBeijing(now), result.cost);
    } finally {
      await releaseRuntimeLock(env, LOCK_KV);
    }
  } catch (e) {
    console.error("[memo] refresh failed:", e);
  }
}
