/**
 * D1 消息存取（v2 结构）。
 *
 * 一轮对话的建模：
 * - 用户发起：先插入 user 行（turn_id 暂用占位），再回填 turn_id = 自己的 id；
 *   随后 assistant 回复行 turn_id = user 的 id，reply_to_id = user 的 id。
 * - AI 主动：只有 assistant 行，turn_id = 自己的 id，turn_type = 'proactive'，reply_to_id = NULL。
 *
 * 这样任意一行都能通过 turn_id 找到同轮的其他消息，也能用 turn_type 区分来源。
 */
import type { Env } from './types';
import { dateKeyInBeijing, isoInBeijing } from './date';

export type MessageRole = 'user' | 'assistant';
export type TurnType = 'chat' | 'proactive';
export type ProactiveKind = 'morning' | 'evening' | 'random';
export type Channel = 'web' | 'astrobot' | 'mobile' | 'desktop' | 'pet';

export interface MessageRow {
  id: number;
  role: MessageRole;
  content: string;
  turn_id: number;
  turn_type: TurnType;
  reply_to_id: number | null;
  channel: Channel;
  proactive_kind: ProactiveKind | null;
  cost_rmb: number;
  prompt_tokens: number;
  completion_tokens: number;
  date_key: string;
  created_at: string;
  created_ms: number;
}

const SELECT_COLS = `id, role, content, turn_id, turn_type, reply_to_id, channel, proactive_kind,
  cost_rmb, prompt_tokens, completion_tokens, date_key, created_at, created_ms`;

export interface InsertOptions {
  channel?: Channel;
  turnType?: TurnType;
  proactiveKind?: ProactiveKind;
  /** 用户消息：无需传；助手回复用户：传 user 消息的 id */
  replyToId?: number;
  /** 主动消息：turn_id = 自己的 id（插入后回填） */
}

/** 插入用户消息（开启一轮对话），返回该行（turn_id 已回填为自身 id）。 */
export async function insertUserMessage(
  env: Env,
  content: string,
  at: Date = new Date(),
  opts: InsertOptions = {},
): Promise<MessageRow> {
  const created_at = isoInBeijing(at);
  const created_ms = at.getTime();
  const date_key = dateKeyInBeijing(at);
  const channel = opts.channel ?? 'web';

  const row = await env.DB.prepare(
    `INSERT INTO messages (role, content, turn_id, turn_type, reply_to_id, channel, date_key, created_at, created_ms)
     VALUES ('user', ?, 0, 'chat', NULL, ?, ?, ?, ?)
     RETURNING ${SELECT_COLS}`,
  )
    .bind(content, channel, date_key, created_at, created_ms)
    .first<MessageRow>();
  if (!row) throw new Error('insert user message failed');

  // 回填 turn_id = 自己的 id
  await env.DB.prepare('UPDATE messages SET turn_id = ? WHERE id = ?').bind(row.id, row.id).run();
  return { ...row, turn_id: row.id };
}

/**
 * 插入助手回复（回复用户消息）。
 *
 * ★ 费用与 token 在流结束时已经知道，直接随 INSERT 写入，
 *   省掉一条额外的 UPDATE（每条回复少一次 D1 写）。
 */
export async function insertAssistantReply(
  env: Env,
  content: string,
  replyToId: number,
  at: Date = new Date(),
  opts: InsertOptions & { cost?: number; promptTokens?: number; completionTokens?: number } = {},
): Promise<MessageRow> {
  const created_at = isoInBeijing(at);
  const created_ms = at.getTime();
  const date_key = dateKeyInBeijing(at);
  const channel = opts.channel ?? 'web';

  const row = await env.DB.prepare(
    `INSERT INTO messages (role, content, turn_id, turn_type, reply_to_id, channel,
       cost_rmb, prompt_tokens, completion_tokens, date_key, created_at, created_ms)
     VALUES ('assistant', ?, ?, 'chat', ?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING ${SELECT_COLS}`,
  )
    .bind(
      content,
      replyToId,
      replyToId,
      channel,
      opts.cost ?? 0,
      opts.promptTokens ?? 0,
      opts.completionTokens ?? 0,
      date_key,
      created_at,
      created_ms,
    )
    .first<MessageRow>();
  if (!row) throw new Error('insert assistant reply failed');
  return row;
}

/** 插入 AI 主动消息（turn_id = 自己的 id，reply_to_id = NULL）。 */
export async function insertProactiveMessage(
  env: Env,
  content: string,
  kind: ProactiveKind,
  at: Date = new Date(),
  opts: InsertOptions = {},
): Promise<MessageRow> {
  const created_at = isoInBeijing(at);
  const created_ms = at.getTime();
  const date_key = dateKeyInBeijing(at);
  const channel = opts.channel ?? 'web';

  const row = await env.DB.prepare(
    `INSERT INTO messages (role, content, turn_id, turn_type, reply_to_id, channel, proactive_kind, date_key, created_at, created_ms)
     VALUES ('assistant', ?, 0, 'proactive', NULL, ?, ?, ?, ?, ?)
     RETURNING ${SELECT_COLS}`,
  )
    .bind(content, channel, kind, date_key, created_at, created_ms)
    .first<MessageRow>();
  if (!row) throw new Error('insert proactive message failed');

  await env.DB.prepare('UPDATE messages SET turn_id = ? WHERE id = ?').bind(row.id, row.id).run();
  return { ...row, turn_id: row.id };
}

/** 最近 N 条消息（按时间正序返回）。 */
export async function recentMessages(env: Env, limit = 20): Promise<MessageRow[]> {
  const result = await env.DB.prepare(
    `SELECT ${SELECT_COLS} FROM messages ORDER BY id DESC LIMIT ?`,
  )
    .bind(limit)
    .all<MessageRow>();
  return (result.results ?? []).reverse();
}

/**
 * 把历史消息压成更省 token 的形式（注入提示词用，不改 D1 原数据）：
 * - `[图片:images/...]` 这种 R2 路径缩成 `[图片]`（模型不需要知道路径）；
 * - 连续空白折叠成一个空格（B站/网页抓取块常带大量换行）；
 * - 超过 maxChars 截断（旧消息细节交给中期记忆/今日摘要）。
 */
export function compactHistoryMessage(content: string, maxChars = 400): string {
  const cleaned = content
    .replace(/\[图片:images\/[^\]]+\]/g, '[图片]')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > maxChars ? `${cleaned.slice(0, maxChars)}…` : cleaned;
}

/** 增量读取：id 大于 afterId 的消息（升序），用于前端实时刷新。 */
export async function messagesSince(
  env: Env,
  afterId: number,
  limit: number,
): Promise<{ messages: MessageRow[]; hasMore: boolean }> {
  const results = await env.DB.prepare(
    `SELECT ${SELECT_COLS} FROM messages WHERE id > ? ORDER BY id ASC LIMIT ?`,
  )
    .bind(afterId, limit + 1)
    .all<MessageRow>();
  const rows = results.results ?? [];
  const hasMore = rows.length > limit;
  return { messages: rows.slice(0, limit), hasMore };
}

/** 分页读取历史（前端回放用）：按 id 倒序取一页再翻转升序。 */
export async function messagesPage(
  env: Env,
  opts: { beforeId?: number; limit: number },
): Promise<{ messages: MessageRow[]; hasMore: boolean }> {
  const results = opts.beforeId
    ? await env.DB.prepare(
        `SELECT ${SELECT_COLS} FROM messages WHERE id < ? ORDER BY id DESC LIMIT ?`,
      )
        .bind(opts.beforeId, opts.limit + 1)
        .all<MessageRow>()
    : await env.DB.prepare(
        `SELECT ${SELECT_COLS} FROM messages ORDER BY id DESC LIMIT ?`,
      )
        .bind(opts.limit + 1)
        .all<MessageRow>();
  const rows = results.results ?? [];
  const hasMore = rows.length > opts.limit;
  return { messages: rows.slice(0, opts.limit).reverse(), hasMore };
}

/** 最新一条消息（增量落库去重用）。 */
export async function latestMessage(env: Env): Promise<MessageRow | null> {
  const row = await env.DB.prepare(
    `SELECT ${SELECT_COLS} FROM messages ORDER BY id DESC LIMIT 1`,
  ).first<MessageRow>();
  return row ?? null;
}

/** 回填费用与 token 用量。 */
export async function updateMessageUsage(
  env: Env,
  id: number,
  usage: { cost: number; promptTokens?: number; completionTokens?: number },
): Promise<void> {
  await env.DB.prepare(
    'UPDATE messages SET cost_rmb = ?, prompt_tokens = ?, completion_tokens = ? WHERE id = ?',
  )
    .bind(usage.cost, usage.promptTokens ?? 0, usage.completionTokens ?? 0, id)
    .run();
}

/** 按天聚合用量（计费接口用）。 */
export async function usageByDay(
  env: Env,
  sinceDateKey: string,
): Promise<Array<{ date: string; messages: number; cost: number; prompt_tokens: number; completion_tokens: number }>> {
  const rows = await env.DB.prepare(
    `SELECT date_key AS date,
            COUNT(*) AS messages,
            ROUND(SUM(cost_rmb), 6) AS cost,
            SUM(prompt_tokens) AS prompt_tokens,
            SUM(completion_tokens) AS completion_tokens
     FROM messages
     WHERE date_key >= ?
     GROUP BY date_key
     ORDER BY date_key ASC`,
  )
    .bind(sinceDateKey)
    .all<{ date: string; messages: number; cost: number | null; prompt_tokens: number | null; completion_tokens: number | null }>();
  return (rows.results ?? []).map((r) => ({
    date: r.date,
    messages: r.messages,
    cost: r.cost ?? 0,
    prompt_tokens: r.prompt_tokens ?? 0,
    completion_tokens: r.completion_tokens ?? 0,
  }));
}

/** 某天的全部消息（归档用）。 */
export async function messagesByDate(env: Env, dateKey: string): Promise<MessageRow[]> {
  const res = await env.DB.prepare(
    `SELECT ${SELECT_COLS} FROM messages WHERE date_key = ? ORDER BY id ASC`,
  )
    .bind(dateKey)
    .all<MessageRow>();
  return res.results ?? [];
}

/** 最近的 AI 主动消息（避免内容重复用）。 */
export async function recentProactiveMessages(env: Env, limit = 6): Promise<MessageRow[]> {
  const res = await env.DB.prepare(
    `SELECT ${SELECT_COLS} FROM messages WHERE turn_type = 'proactive' ORDER BY id DESC LIMIT ?`,
  )
    .bind(limit)
    .all<MessageRow>();
  return res.results ?? [];
}
