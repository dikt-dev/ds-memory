/**
 * 主动消息的时间/随机工具 + 投递通道。
 *
 * 说明：主动消息的「决策与生成」统一在 webproactive.ts（打分 + 事由驱动），
 * 本模块只负责：
 * - 时间窗口与随机目标时间（纯函数，供 Web 端决策前判断）；
 * - 投递通道 deliverProactive（直连 AstrBot / 入队供插件轮询）。
 */

import type { Env } from './types';
import { enqueueProactive } from './queue';

export type ProactiveSlot = 'morning' | 'evening';

/** 发送窗口（北京时间，分钟数） */
export const PROACTIVE_WINDOWS: Record<ProactiveSlot, { start: number; end: number; name: string }> = {
  morning: { start: 7 * 60 + 45, end: 8 * 60 + 15, name: '早上' },
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

/** 当前处于哪个发送窗口（不在窗口内返回 null）。 */
export function currentSlot(minutes: number): ProactiveSlot | null {
  for (const slot of ['morning', 'evening'] as const) {
    const w = PROACTIVE_WINDOWS[slot];
    if (minutes >= w.start && minutes < w.end) return slot;
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
    .slice(0, 200);
}

/* ---------- 随机主动聊天的时段参数 ---------- */

/** 随机主动聊天的时段边界（北京时间分钟数）：避开早晚固定时段与凌晨睡眠。 */
export const RANDOM_WINDOW = { start: 9 * 60, end: 22 * 60 + 30 };
/** 单日最多随机消息条数 */
export const RANDOM_MAX_PER_DAY = 2;
/** 两次随机消息的最小间隔（分钟） */
export const RANDOM_MIN_GAP = 90;

/** 当天是否发随机消息、发几条（纯随机：0 / 1 / 2）。 */
export function randomCountFor(dateKey: string): number {
  const r = seededRandom01(`${dateKey}:random-count`);
  if (r < 0.35) return 0; // 35% 概率今天不发
  if (r < 0.85) return 1; // 50% 概率发 1 条
  return 2; // 15% 概率发 2 条
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

/**
 * 投递主动消息：两种模式
 * - 直连模式（已配置 ASTRBOT_BASE_URL）：Worker 直接调 AstrBot HTTP API
 * - 队列模式（未配置）：消息入队，由 AstrBot 插件轮询拉取后本地发送（无需公网入口）
 * @param messageId 关联的 messages.id（已落库的网页端主动消息），用于队列追踪
 */
export async function deliverProactive(
  env: Env,
  text: string,
  now: Date,
  messageId?: number,
): Promise<{ ok: boolean; mode: 'direct' | 'queue' }> {
  if (env.ASTRBOT_BASE_URL && env.ASTROBOT_OPENAPI_KEY && env.ASTRBOT_UMO) {
    return { ok: await sendToAstrBot(env, text), mode: 'direct' };
  }
  await enqueueProactive(env, text, now, messageId);
  return { ok: true, mode: 'queue' };
}

/** 直连模式：Worker 调 AstrBot HTTP API 发送。 */
async function sendToAstrBot(env: Env, text: string): Promise<boolean> {
  try {
    const base = (env.ASTRBOT_BASE_URL ?? '').replace(/\/+$/, '');
    const res = await fetch(`${base}/api/v1/im/message`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${env.ASTROBOT_OPENAPI_KEY}`,
      },
      body: JSON.stringify({ umo: env.ASTRBOT_UMO, message: text }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.error('[proactive] AstrBot send failed:', res.status, detail.slice(0, 200));
      return false;
    }
    return true;
  } catch (e) {
    console.error('[proactive] AstrBot fetch failed:', e);
    return false;
  }
}

export interface ProactiveResult {
  skipped?: string;
  sent?: boolean;
  message?: string;
  error?: string;
  kind?: string;
  score?: number;
  reasons?: string[];
}