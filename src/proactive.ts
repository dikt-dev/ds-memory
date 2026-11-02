/**
 * 主动消息的时间/随机工具 + 投递通道。
 *
 * 说明：主动消息的「决策与生成」统一在 webproactive.ts（打分 + 事由驱动），
 * 本模块只负责：
 * - 时间窗口与随机目标时间（纯函数，供 Web 端决策前判断）；
 * - 投递通道 deliverProactive（直连 AstrBot / 入队供客户端轮询）。
 */

import type { Env } from './types';
import { logError, logWarn } from './error-log';

export type ProactiveSlot = 'morning' | 'evening';

/** 发送窗口（北京时间，分钟数） */
export const PROACTIVE_WINDOWS: Record<ProactiveSlot, { start: number; end: number; name: string }> = {
  morning: { start: 8 * 60 + 10, end: 8 * 60 + 40, name: '早上' },
  evening: { start: 22 * 60 + 45, end: 23 * 60 + 15, name: '深夜' },
};

/** 北京时间的"当天第几分钟"（0-1439）。 */
export function beijingMinutes(now: Date): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return (get('hour') % 24) * 60 + get('minute');
}

/** 当前处于哪个发送窗口（不在窗口内返回 null）。
 *
 * end 这一分钟也算在窗口内：cron 每 5 分钟触发一次，而目标时间是分钟级随机值，
 * 例如 evening 目标 23:12 时，23:10 还没到、23:15 如果算窗口外就永远不会发。
 */
export function currentSlot(minutes: number): ProactiveSlot | null {
  for (const slot of ['morning', 'evening'] as const) {
    const w = PROACTIVE_WINDOWS[slot];
    if (minutes >= w.start && minutes <= w.end) return slot;
  }
  return null;
}

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** 确定性伪随机（0~1），同一天同一时段结果固定。 */
export function seededRandom01(seed: string): number {
  let t = hashString(seed) + 0x6d2b79f5;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** 当天的随机目标时间（窗口起点 + 0~窗口长度分钟）。 */
export function targetMinutesFor(dateKey: string, slot: ProactiveSlot): number {
  const w = PROACTIVE_WINDOWS[slot];
  return w.start + Math.floor(seededRandom01(`${dateKey}:${slot}`) * (w.end - w.start));
}

/** 清理生成的文本（去引号/前缀、限长）。 */
export function sanitizeProactiveText(text: string): string {
  return text
    .trim()
    .replace(/^[“”"'‘’\s]+|[“”"'‘’\s]+$/g, '')
    .replace(/^(消息|内容|回复)[:：]\s*/, '')
    .trim()
    .slice(0, 500);
}

/* ---------- 随机主动聊天的时段参数 ---------- */

/** 随机主动聊天的时段边界（北京时间分钟数）：避开早晚固定时段与凌晨睡眠。 */
export const RANDOM_WINDOW = { start: 9 * 60, end: 22 * 60 + 30 };
/** 单日最多随机消息条数（按强度档，亲密度越高上限越高） */
export const RANDOM_MAX_PER_DAY = 3;
export const RANDOM_MAX_BY_LEVEL = { quiet: 1, normal: 2, active: 3 } as const;
/** 两次随机消息的最小间隔（分钟） */
export const RANDOM_MIN_GAP = 90;

/**
 * 当天是否发随机消息、发几条。
 *
 * 亲密度决定「概率」和「上限」，不是每天必发：
 *   quiet  → 75% 不发，最多 1 条
 *   normal → 45% 不发，最多 2 条
 *   active → 15% 不发，最多 3 条
 * 结果按日期种子确定性生成，同一天刷新计划不会变。
 */
export function randomCountFor(
  dateKey: string,
  level: 'quiet' | 'normal' | 'active' = 'normal',
): number {
  const r = seededRandom01(`${dateKey}:random-count:${level}`);
  if (level === 'quiet') return r < 0.75 ? 0 : 1;
  if (level === 'active') {
    if (r < 0.15) return 0;
    if (r < 0.7) return 1;
    if (r < 0.93) return 2;
    return 3;
  }
  if (r < 0.45) return 0;
  if (r < 0.85) return 1;
  return 2;
}

/**
 * 当天第 n 条随机消息的目标时间（窗口内随机）。
 * 第 1 条限制在窗口前 55% 内（避免随机到太晚、一整天看不到主动消息）；
 * 第 2 条保证与第 1 条间隔 ≥ RANDOM_MIN_GAP，放不下则返回窗口末尾（当天不发）。
 */
export function randomTargetMinutes(dateKey: string, index: number): number {
  const span = RANDOM_WINDOW.end - RANDOM_WINDOW.start;
  const rnd = seededRandom01(`${dateKey}:random-${index}`);
  if (index === 0) {
    // 前 55% 窗口内随机：约 09:00–16:30，保证一天内能较早出现
    return RANDOM_WINDOW.start + Math.floor(rnd * Math.floor(span * 0.55));
  }

  const prev = randomTargetMinutes(dateKey, index - 1);
  const earliest = prev + RANDOM_MIN_GAP;
  if (earliest >= RANDOM_WINDOW.end) return RANDOM_WINDOW.end; // 放不下：返回窗口末尾（调用方视为当天不再发）
  const latest = RANDOM_WINDOW.end - 1;
  return earliest + Math.floor(rnd * (latest - earliest + 1));
}

/* ---------- 投递通道 ---------- */

export interface DeliveryResult {
  ok: boolean;
  /** 现在只有 events 一种；保留旧值是为了读历史日志。 */
  mode: 'direct' | 'queue' | 'events';
  /**
   * 实际状态：
   * - `sent`：直连模式，AstrBot 已确认收到 → 确实送达
   * - `queued`：队列模式，**仅代表已入队**，不代表对方已收到
   * - `failed`：直连失败或入队失败
   */
  status: 'sent' | 'queued' | 'failed';
}

/**
 * 投递主动消息：单通道 —— events。
 *
 * 消息先落 messages，App 通过 /api/app/events 增量拉取（闹钟唤醒或前台轮询）。
 * 2026-10-31 起废弃 QQ / AstrBot 直连与队列轮询两条老路：
 * 队列要一个常驻消费者，实际没人取，消息在库里躺到过期，
 * proactive_log 永远停在 queued，看起来像发送失败——比不投递更糟。
 */
export async function deliverProactive(
  env: Env,
  text: string,
  now: Date,
  messageId?: number,
): Promise<DeliveryResult> {
  void env;
  void text;
  void now;
  void messageId;
  return { ok: true, mode: 'events', status: 'sent' };
}