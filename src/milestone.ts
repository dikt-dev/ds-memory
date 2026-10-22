/**
 * 记忆里程碑（纯函数）。
 *
 * 检测值得主动提起的时间节点：
 * - 认识第 N 天（100/200/365/500/1000 天）
 * - 首次对话周年
 * - 连续聊天天数里程碑（7/30/100 天）
 * - 记忆条目数里程碑
 */
import type { Env } from './types';

export interface Milestone {
  kind: 'anniversary' | 'streak' | 'count';
  /** 提示词里用的话题描述 */
  topic: string;
  /** 强度加成 */
  weight: number;
}

const ANNIVERSARY_DAYS = [7, 30, 50, 100, 200, 365, 500, 730, 1000];
const STREAK_DAYS = [7, 14, 30, 60, 100, 200, 365];

export interface MilestoneInput {
  /** 首次对话日期（YYYY-MM-DD），null = 还没有 */
  firstChatDate: string | null;
  /** 今天（YYYY-MM-DD） */
  today: string;
  /** 连续聊天天数（含今天） */
  streakDays: number;
  /** memory.md 里的记忆条目总数 */
  memoryEntryCount: number;
}

/** 计算两个日期相差天数。 */
export function daysBetween(fromDateKey: string, toDateKey: string): number {
  const [y1, m1, d1] = fromDateKey.split('-').map(Number);
  const [y2, m2, d2] = toDateKey.split('-').map(Number);
  const a = Date.UTC(y1, m1 - 1, d1);
  const b = Date.UTC(y2, m2 - 1, d2);
  return Math.round((b - a) / 86400000);
}

/** 检测今天的里程碑（纯函数，可测试）。 */
export function detectMilestones(input: MilestoneInput): Milestone[] {
  const out: Milestone[] = [];

  if (input.firstChatDate) {
    const days = daysBetween(input.firstChatDate, input.today);
    if (ANNIVERSARY_DAYS.includes(days)) {
      out.push({
        kind: 'anniversary',
        topic: `今天是我们认识第 ${days} 天`,
        weight: days >= 365 ? 40 : 30,
      });
    }
  }

  if (STREAK_DAYS.includes(input.streakDays)) {
    out.push({
      kind: 'streak',
      topic: `已经连续聊了 ${input.streakDays} 天`,
      weight: 25,
    });
  }

  if (input.memoryEntryCount > 0 && input.memoryEntryCount % 50 === 0) {
    out.push({
      kind: 'count',
      topic: `记忆里已经存了 ${input.memoryEntryCount} 条关于你的事`,
      weight: 15,
    });
  }

  return out;
}

/** 从 D1 计算连续聊天天数（含今天，允许断一天）。 */
export async function computeStreak(env: Env, today: string): Promise<number> {
  const rows = await env.DB.prepare(
    `SELECT DISTINCT date_key FROM messages ORDER BY date_key DESC LIMIT 400`,
  ).all<{ date_key: string }>();
  const dates = new Set((rows.results ?? []).map((r) => r.date_key));
  if (dates.size === 0) return 0;

  let streak = 0;
  let cursor = today;
  // 从今天往前数；今天没有消息则从昨天开始算（不算断）
  if (!dates.has(cursor)) {
    const [y, m, d] = cursor.split('-').map(Number);
    const prev = new Date(Date.UTC(y, m - 1, d - 1));
    cursor = `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}-${String(prev.getUTCDate()).padStart(2, '0')}`;
  }
  for (let i = 0; i < 400; i++) {
    if (!dates.has(cursor)) break;
    streak += 1;
    const [y, m, d] = cursor.split('-').map(Number);
    const prev = new Date(Date.UTC(y, m - 1, d - 1));
    cursor = `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}-${String(prev.getUTCDate()).padStart(2, '0')}`;
  }
  return streak;
}

/** 取首次对话日期。 */
export async function getFirstChatDate(env: Env): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT MIN(date_key) AS d FROM messages WHERE role = 'user'`,
  ).first<{ d: string | null }>();
  return row?.d ?? null;
}

/** 距最后一条用户消息过了多少天（用于关系衰减）。 */
export async function daysSinceLastUserMessage(env: Env, now: Date): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT created_ms FROM messages WHERE role = 'user' ORDER BY id DESC LIMIT 1`,
  ).first<{ created_ms: number }>();
  if (!row) return 0;
  return Math.floor((now.getTime() - row.created_ms) / 86400000);
}

/** 统计 memory.md 里的记忆条目数（以 "- [日期]" 开头的行）。 */
export function countMemoryEntries(memory: string): number {
  return (memory.match(/^-\s*\[\d{4}-\d{2}-\d{2}\]/gm) ?? []).length;
}
