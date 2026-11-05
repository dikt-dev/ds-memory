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
export type ProactiveKind = 'morning' | 'evening' | 'random'; // 见闻也落 random（表上有 CHECK 约束）
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
  client_message_id?: string | null;
}

const SELECT_COLS = `id, role, content, turn_id, turn_type, reply_to_id, channel, proactive_kind,
  cost_rmb, prompt_tokens, completion_tokens, date_key, created_at, created_ms, client_message_id`;

export interface InsertOptions {
  channel?: Channel;
  turnType?: TurnType;
  proactiveKind?: ProactiveKind;
  /** 用户消息：无需传；助手回复用户：传 user 消息的 id */
  replyToId?: number;
  /** App 发来的幂等键；同一 id 重试复用同一行，避免本地 pending + 服务端回显双气泡 */
  clientMessageId?: string;
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
  const clientMessageId =
    typeof opts.clientMessageId === 'string' && opts.clientMessageId.trim()
      ? opts.clientMessageId.trim()
      : null;

  // App 重试/轮询可能把同一 client_message_id 再送一次：直接复用已有行。
  if (clientMessageId) {
    const existing = await env.DB.prepare(
      `SELECT ${SELECT_COLS} FROM messages WHERE client_message_id = ? LIMIT 1`,
    )
      .bind(clientMessageId)
      .first<MessageRow>();
    if (existing) return existing;
  }

  const row = await env.DB.prepare(
    `INSERT INTO messages
       (role, content, turn_id, turn_type, reply_to_id, channel, date_key, created_at, created_ms, client_message_id)
     VALUES ('user', ?, 0, 'chat', NULL, ?, ?, ?, ?, ?)
     RETURNING ${SELECT_COLS}`,
  )
    .bind(content, channel, date_key, created_at, created_ms, clientMessageId)
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

/** 消息比较：先时间，再 id，保证同一毫秒内也有稳定顺序。 */
function compareMessages(a: MessageRow, b: MessageRow): number {
  return a.created_ms - b.created_ms || a.id - b.id;
}

/**
 * 按 turn_id 分组（一轮 = 用户消息 + 它的回复，或一条主动消息）。
 * 导出为纯函数，方便测试「上一句/上上句」的排序。
 */
export function groupTurns(rows: MessageRow[]): MessageRow[][] {
  const seen = new Set<number>();
  const map = new Map<number, MessageRow[]>();
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    const key = Number.isFinite(row.turn_id) && row.turn_id > 0 ? row.turn_id : row.id;
    const list = map.get(key) ?? [];
    list.push(row);
    map.set(key, list);
  }
  const groups = [...map.values()].map((g) => g.slice().sort(compareMessages));
  groups.sort((a, b) => compareMessages(a[0], b[0]));
  return groups;
}

/** 取最近 N 轮（按时间从旧到新）。 */
export function takeLastRounds(rows: MessageRow[], rounds: number): MessageRow[] {
  const n = Math.max(1, Math.floor(rounds));
  return groupTurns(rows).slice(-n).flat();
}

/** 从 D1 取最近 N 轮消息（按 turn_id 分组，时间升序）。 */
export async function recentRoundMessages(env: Env, rounds: number): Promise<MessageRow[]> {
  const limit = Math.max(1, Math.min(Math.floor(rounds), 30));
  // turn_id=0 的旧数据按单条消息自成一轮，避免把很多无 turn 的消息合成一轮
  const turnExpr = '(CASE WHEN turn_id > 0 THEN turn_id ELSE id END)';
  const ids = await env.DB.prepare(
    `SELECT ${turnExpr} AS turn_key FROM messages
     GROUP BY ${turnExpr}
     ORDER BY MAX(created_ms) DESC, MAX(id) DESC
     LIMIT ?`,
  )
    .bind(limit)
    .all<{ turn_key: number }>();
  const turnIds = (ids.results ?? [])
    .map((r) => r.turn_key)
    .filter((n) => Number.isFinite(n));
  if (turnIds.length === 0) return [];

  const placeholders = turnIds.map(() => '?').join(',');
  const res = await env.DB.prepare(
    `SELECT ${SELECT_COLS} FROM messages
     WHERE ${turnExpr} IN (${placeholders})
     ORDER BY created_ms ASC, id ASC
     LIMIT 500`,
  )
    .bind(...turnIds)
    .all<MessageRow>();
  return (res.results ?? []).sort(compareMessages);
}

/** 历史单条消息默认保留的字符数：最近 10 轮优先保质量，不做过度压缩。 */
export const HISTORY_MESSAGE_MAX_CHARS = 2400;
/** 带文件的消息保留更多字符，保证“那个表第三行”还能对上。 */
export const HISTORY_FILE_MAX_CHARS = 4200;

/**
 * 把历史消息压成更省 token 的形式（注入提示词用，不改 D1 原数据）：
 * - `[图片:images/...]` 这种 R2 路径缩成 `[图片]`（模型不需要知道路径）；
 * - 连续空白折叠成一个空格（B站/网页抓取块常带大量换行）；
 * - 超长时保留开头 + 结尾（结尾常包含结论/追问），中间省略，避免只剩开头。
 */
/**
 * 占位符清洗：把 R2 路径压成可读标记。
 *
 * 历史注入和每日提炼共用同一份规则——两边不一致时，
 * 提炼会把 `[视频:videos/2026-10-28/<uuid>.mp4]` 当成正文写进 memory.md。
 */
export function sanitizeMessagePlaceholders(content: string): string {
  return content
    // 静默标记不是聊天内容，历史里也不能留。
    .replace(/\[END\]/g, '')
    // 完整字幕/网页资料只保留标记，避免把上下文撑爆。
    .replace(/\[BILI_META\][\s\S]*?\[\/BILI_META\]/gi, '[B站资料]')
    .replace(/\[VIDEO_META\][\s\S]*?\[\/VIDEO_META\]/gi, '[视频资料]')
    .replace(/\[WEB_META\][\s\S]*?\[\/WEB_META\]/gi, '[网页资料]')
    .replace(/\[图片:images\/[^\]]+\]/g, '[图片]')
    .replace(/\[视频:videos\/[^\]]+\]/g, '[视频]')
    .replace(/\[GIF:gifs\/[^\]]+\]/g, '[GIF]')
    .replace(/\[语音:audio\/[^\]]+\]/g, '[语音]');
}

export function compactHistoryMessage(content: string, maxChars = HISTORY_MESSAGE_MAX_CHARS): string {
  const cleaned = sanitizeMessagePlaceholders(content)
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length <= maxChars) return cleaned;
  const head = Math.max(1, Math.ceil(maxChars * 0.7));
  const tail = Math.max(1, Math.floor(maxChars * 0.3) - 1);
  return `${cleaned.slice(0, head)}…${cleaned.slice(-tail)}`;
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
    `SELECT ${SELECT_COLS} FROM messages WHERE date_key = ? ORDER BY id ASC LIMIT 2000`,
  )
    .bind(dateKey)
    .all<MessageRow>();
  return res.results ?? [];
}

/** 短期历史注入时的时间标签（月-日 时:分，北京时间）。 */
export function historyTimeLabel(createdAt: string): string {
  // createdAt 形如 2026-10-24T17:37:39+08:00
  return (createdAt || '').slice(5, 16).replace('T', ' ') || '时间未知';
}

/** 给历史消息加上时间戳前缀（只进入本轮请求，不写回 D1）。 */
export function withHistoryTimestamp(content: string, createdAt: string): string {
  return `[${historyTimeLabel(createdAt)}] ${content}`;
}

/**
 * 给最近 N 轮历史配一句顺序说明。
 *
 * 时间戳逐条放在消息开头，模型才能明确“上一句/上上句”；
 * 同时提醒它这些标签只是元信息，回复里不要模仿输出。
 */
export function historyRangeNote(rows: MessageRow[], now: Date): string | null {
  if (rows.length === 0) return null;
  const groups = groupTurns(rows);
  const first = rows[0];
  const last = rows[rows.length - 1];
  const hours = Math.max(0, Math.round((now.getTime() - last.created_ms) / 3600000));
  const gap = Math.max(0, Math.round((last.created_ms - first.created_ms) / 3600000));
  return (
    `【历史顺序】接下来是最近 ${groups.length} 轮聊天记录，按时间从旧到新排列；` +
    `每条开头的 [MM-DD HH:mm] 是发送时间，只用于判断先后，回复时绝对不要输出时间标签。` +
    `最后一条是最近一条历史消息，当前用户消息在它之后。` +
    `最早 ${historyTimeLabel(first.created_at)}，最近 ${historyTimeLabel(last.created_at)}；` +
    `距现在约 ${hours} 小时，跨度约 ${gap} 小时。`
  );
}

/** 网页 → QQ 同步：只取网页渠道的普通聊天，按 id 增量。 */
export async function webMessagesSince(
  env: Env,
  afterId: number,
  limit: number,
): Promise<{ messages: MessageRow[]; hasMore: boolean }> {
  const results = await env.DB.prepare(
    `SELECT ${SELECT_COLS} FROM messages
     WHERE id > ? AND channel = 'web' AND proactive_kind IS NULL
     ORDER BY id ASC LIMIT ?`,
  )
    .bind(afterId, limit + 1)
    .all<MessageRow>();
  const rows = results.results ?? [];
  const hasMore = rows.length > limit;
  return { messages: rows.slice(0, limit), hasMore };
}

/** 网页渠道当前最大 id；客户端首次启动用这个做基线，避免重放历史。 */
export async function latestWebMessageId(env: Env): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COALESCE(MAX(id), 0) AS id FROM messages
     WHERE channel = 'web' AND proactive_kind IS NULL`,
  ).first<{ id: number }>();
  return Number(row?.id ?? 0);
}

/** 某条用户消息对应的助手回复（可能落在下一天，归档补全用）。 */
export async function assistantReplyTo(env: Env, userMessageId: number): Promise<MessageRow | null> {
  const res = await env.DB.prepare(
    `SELECT ${SELECT_COLS} FROM messages WHERE reply_to_id = ? AND role = 'assistant' ORDER BY id ASC LIMIT 1`,
  )
    .bind(userMessageId)
    .first<MessageRow>();
  return res ?? null;
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
