/**
 * 活人感状态所需的数据采集（从 D1 读取）。
 * 被 chat.ts / openai.ts 调用，避免重复 SQL。
 */
import type { Env } from './types';

export interface SessionFacts {
  /** 距最近一条用户消息的小时数；null = 从未聊过 */
  hoursSinceLastContact: number | null;
  /** 今天用户消息条数（近似"今天聊了多少轮"） */
  todayTurns: number;
  /** 最近的主动消息是否被冷落（发了但用户没回，且已过 2 小时）；用于"有点小情绪" */
  wasIgnored: boolean;
  /** 被冷落的主动消息内容片段（供"你可算来了"之类自然引用） */
  ignoredMessage: string | null;
}

/** 读取"距上次聊天"与"今日轮数" + 被冷落状态。 */
export async function readSessionFacts(env: Env, now: Date, dateKey: string): Promise<SessionFacts> {
  // ★ 合并成一次查询：最后一条用户消息 + 今天用户消息数（原为两次独立的 D1 读）
  const stats = await env.DB.prepare(
    `SELECT (SELECT created_ms FROM messages WHERE role = 'user' ORDER BY id DESC LIMIT 1) AS last_ms,
            (SELECT COUNT(*) FROM messages WHERE role = 'user' AND date_key = ?) AS today_turns`,
  )
    .bind(dateKey)
    .first<{ last_ms: number | null; today_turns: number | null }>();

  const lastMs = stats?.last_ms ?? null;
  const hoursSinceLastContact = lastMs === null ? null : (now.getTime() - lastMs) / 3600000;
  const todayTurns = stats?.today_turns ?? 0;

  // ★ 被冷落检测：最近一条主动消息 + 它之后有没有用户回复（相关子查询一次带出 reply_id）
  let wasIgnored = false;
  let ignoredMessage: string | null = null;
  try {
    const pro = await env.DB.prepare(
      `SELECT p.id, p.content, p.created_ms,
              (SELECT MIN(m.id) FROM messages m WHERE m.role = 'user' AND m.id > p.id) AS reply_id
         FROM messages p
        WHERE p.turn_type = 'proactive'
        ORDER BY p.id DESC
        LIMIT 1`,
    ).first<{ id: number; content: string; created_ms: number; reply_id: number | null }>();

    if (pro) {
      const elapsed = now.getTime() - pro.created_ms;
      // 只关心 2 小时~48 小时内的（太久远的"冷落"没意义，也不算新鲜情绪）
      if (elapsed > 2 * 3600000 && elapsed < 48 * 3600000 && pro.reply_id === null) {
        wasIgnored = true;
        ignoredMessage = pro.content;
      }
    }
  } catch {
    // 忽略，不影响主流程
  }

  return { hoursSinceLastContact, todayTurns, wasIgnored, ignoredMessage };
}