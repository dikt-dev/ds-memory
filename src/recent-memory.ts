/**
 * 中期记忆：最近 24 小时的滚动事实纪要。
 *
 * 为什么需要这一层：
 * - 长期记忆（memory.md）每天 04:00 才更新一次，体现不了「最近一天」；
 * - 今日摘要按自然日重置，跨零点就断片；
 * - 原始消息只有最近 20 条，聊多一点就看不到昨天半夜说的那件事。
 *
 * 所以这里单独维护一份「最近 24 小时」的短纪要（5~8 条、每条 ≤24 字），
 * 每 3 小时或每 15 条新消息刷新一次，注入提示词，保证跨天不断片。
 *
 * 三层记忆的分工：
 *   长期 = memory.md（稳定事实，每天提炼）
 *   中期 = memo:24h（最近一天发生了什么，滚动）
 *   短期 = D1 最近 N 条原文
 */
import type { Env } from './types';
import { distillText } from './distill';
import { addLlmCost } from './llm-cost';
import { dateKeyInBeijing } from './date';

const MEMO_KV = 'memo:24h';
const LOCK_KV = 'memo:lock';
const LOCK_TTL_SECONDS = 120;
/** 48 小时过期：即使整天没说话，昨天的纪要也不会立刻消失 */
const MEMO_TTL_SECONDS = 48 * 60 * 60;

/** 纪要覆盖的时间窗口。 */
export const MEMO_WINDOW_MS = 24 * 60 * 60 * 1000;
/** 新增消息达到这个数就刷新一次。 */
export const MEMO_REFRESH_MESSAGES = 15;
/** 或者距上次刷新超过这个时长（3 小时）。 */
export const MEMO_REFRESH_MS = 3 * 60 * 60 * 1000;
/** 注入提示词时最多保留几条。 */
export const MEMO_MAX_ITEMS = 8;
/** 增量太少（比如刚说了一句「在吗」）不值得花一次模型调用。 */
export const MEMO_MIN_NEW_MESSAGES = 4;
/** 单次最多读多少条原始消息，防止一天聊爆时把整张表拉回来。 */
export const MEMO_MAX_SOURCE_MESSAGES = 300;
/** 喂给模型的对话上限（字符），超出时保留最新的部分。 */
export const MEMO_INPUT_MAX_CHARS = 12000;

export interface RecentMemo {
  /** 以 "- " 开头的多行列表 */
  text: string;
  /** 已覆盖到的最大消息 id（增量判断用） */
  up_to_id: number;
  /** ISO 时间 */
  updated_at: string;
}

export interface MemoRow {
  role: string;
  turn_type: string;
  content: string;
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

/** 读取当前中期记忆（没有或格式坏了返回 null）。 */
export async function getRecentMemo(env: Env): Promise<RecentMemo | null> {
  try {
    const raw = await env.KV.get(MEMO_KV);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as RecentMemo;
    if (typeof parsed?.text !== 'string' || !parsed.text.trim()) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * 渲染成提示词里的一块（纯函数）。
 * 只保留 "- " 开头的行，取最后 maxItems 条（最新的在后）。
 */
export function formatRecentMemoBlock(memo: RecentMemo | null, maxItems = MEMO_MAX_ITEMS): string {
  if (!memo) return '';
  const items = memo.text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- '))
    .slice(-maxItems);
  if (items.length === 0) return '';
  return ['## 最近一天（中期记忆）', ...items].join('\n');
}

/**
 * 构造给模型的输入（纯函数）：旧纪要 + 新增对话。
 * 超长时**保留最新的对话**（旧信息已经概括进旧纪要里了）。
 */
export function buildMemoInput(prev: RecentMemo | null, rows: MemoRow[]): string {
  const lines = rows.map((m) => {
    if (m.role === 'user') return `用户：${m.content}`;
    return m.turn_type === 'proactive' ? `助手（主动发起）：${m.content}` : `助手：${m.content}`;
  });
  let conversation = lines.join('\n');
  if (conversation.length > MEMO_INPUT_MAX_CHARS) {
    conversation = conversation.slice(-MEMO_INPUT_MAX_CHARS);
  }
  const head = prev?.text?.trim() ? `【当前纪要】\n${prev.text.trim()}\n\n` : '';
  return `${head}【新增对话】\n${conversation || '（无）'}`;
}

const MEMO_SYSTEM = `你负责维护一份「最近 24 小时」的中期记忆纪要。
你会看到【当前纪要】（可能为空）和【新增对话】。请输出**更新后的完整纪要**：
- 5~8 条，每条一行，以 "- " 开头，24 字以内，电报体（去掉主语和虚词）；
- 保留仍然有效的旧条目；已经过时或被新信息取代的，删掉或合并；
- 只写之后可能被提到的事：正在做的事、情绪变化、约定、决定、遇到的问题；
- 不写寒暄、不复述助手已经回应过的话、不写可推断的事实（时间/天气）；
- 按时间先后排列，最近的在最后；
- 直接输出列表，不要标题、不要解释。`;

/**
 * 按需刷新中期记忆（节流 + 锁，可安全重复调用）。
 * 由聊天请求异步触发（waitUntil），失败不影响聊天。
 */
export async function maybeRefreshRecentMemo(env: Env, now: Date = new Date()): Promise<void> {
  try {
    const prev = await getRecentMemo(env);
    const since = now.getTime() - MEMO_WINDOW_MS;

    const latest = await env.DB.prepare('SELECT id FROM messages ORDER BY id DESC LIMIT 1').first<{
      id: number;
    }>();
    if (!latest) return;

    // 消息表被清空/重建后 id 会回退：旧 memo 的 up_to_id 失效，必须全量重来
    const resetDetected = prev !== null && latest.id < prev.up_to_id;
    const sinceId = resetDetected ? 0 : (prev?.up_to_id ?? 0);

    const counted = await env.DB.prepare(
      'SELECT COUNT(*) AS c FROM messages WHERE created_ms >= ? AND id > ?',
    )
      .bind(since, sinceId)
      .first<{ c: number }>();
    const newMessages = counted?.c ?? 0;
    const ageMs = prev ? now.getTime() - new Date(prev.updated_at).getTime() : Number.POSITIVE_INFINITY;

    if (!shouldRefreshRecentMemo({ newMessages, ageMs })) return;
    if (!hasEnoughNewMaterial(newMessages, resetDetected)) return;

    // ★ 便宜的判断通过后再加锁：否则每条消息都要白写两次 KV（put + delete）
    if (await env.KV.get(LOCK_KV).catch(() => null)) return;
    await env.KV.put(LOCK_KV, '1', { expirationTtl: LOCK_TTL_SECONDS }).catch(() => {});

    try {
      // 增量：只取新消息；冷启动或表重置：取 24h 内最近的 N 条
      const query =
        resetDetected || !prev
          ? env.DB.prepare(
              'SELECT role, turn_type, content FROM messages WHERE created_ms >= ? ORDER BY id DESC LIMIT ?',
            ).bind(since, MEMO_MAX_SOURCE_MESSAGES)
          : env.DB.prepare(
              'SELECT role, turn_type, content FROM messages WHERE created_ms >= ? AND id > ? ORDER BY id DESC LIMIT ?',
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

      const text = result.text
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.startsWith('- '))
        .slice(-MEMO_MAX_ITEMS)
        .join('\n');
      if (!text) return;

      await env.KV.put(MEMO_KV, JSON.stringify({ text, up_to_id: latest.id, updated_at: now.toISOString() }), {
        expirationTtl: MEMO_TTL_SECONDS,
      });
      // 摘要类调用也要计入当天费用（否则 /api/usage 会低估）
      await addLlmCost(env, dateKeyInBeijing(now), result.cost);
    } finally {
      await env.KV.delete(LOCK_KV).catch(() => {});
    }
  } catch (e) {
    console.error('[memo] refresh failed:', e);
  }
}
