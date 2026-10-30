/**
 * 主动消息「今日计划」。
 *
 * 只读查询：告诉客户端今天大概几点她可能来、哪几档已经发过。
 * 为什么不需要建表——时间本来就是日期种子的纯函数
 * （targetMinutesFor / randomTargetMinutes），「发过没」在 proactive_log 里。
 *
 * 客户端用法：拿到 slots 后，在 at - tolerance_min 设一个闹钟（setAndAllowWhileIdle，
 * 不需要 SCHEDULE_EXACT_ALARM），醒来拉一次 /api/app/events 即可。
 * 系统把闹钟拖后十几分钟没关系——主动消息的时间本身就带随机性，用户感知不到。
 */

import { dateKeyInBeijing } from './date';
import {
  PROACTIVE_WINDOWS,
  RANDOM_WINDOW,
  randomCountFor,
  randomTargetMinutes,
  targetMinutesFor,
} from './proactive';
import { getRuntimeState } from './runtime-store';
import type { Env } from './types';

/** 客户端可以比计划时刻早醒多久（分钟）。 */
export const PLAN_TOLERANCE_MIN = 15;
/** 提醒截止线：醒来时已经超过 at + 这个分钟数，就只归档、不弹通知。 */
export const PLAN_NOTIFY_DEADLINE_MIN = 30;

export type PlanKind = 'morning' | 'evening' | 'random';
export type PlanStatus = 'sent' | 'queued' | 'failed';

export interface PlanSlot {
  /** proactive_log.slot_key：morning / evening / random-0 / random-1 */
  key: string;
  kind: PlanKind;
  /** 计划时刻（北京时间 HH:MM） */
  at: string;
  /** 当天的第几分钟（0-1439），客户端换成本地时刻用 */
  at_minutes: number;
  /** 这一档是否已经生成过消息 */
  generated: boolean;
  status: PlanStatus | null;
  message_id: number | null;
}

export interface ProactivePlan {
  date: string;
  paused: boolean;
  paused_until: string | null;
  level: 'quiet' | 'normal' | 'active';
  tolerance_min: number;
  notify_deadline_min: number;
  slots: PlanSlot[];
}

function formatMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * 纯函数：当天有哪些候选档、各在几点。
 * 不含「发没发」——那要查库，见 readPlan。
 */
export function buildPlanSlots(
  dateKey: string,
): Array<{ key: string; kind: PlanKind; at_minutes: number }> {
  const slots: Array<{ key: string; kind: PlanKind; at_minutes: number }> = [
    { key: 'morning', kind: 'morning', at_minutes: targetMinutesFor(dateKey, 'morning') },
    { key: 'evening', kind: 'evening', at_minutes: targetMinutesFor(dateKey, 'evening') },
  ];

  // 白天随机：当天随机决定发 0 / 1 / 2 条，放不下的第二条直接不出现在计划里
  const total = randomCountFor(dateKey);
  for (let i = 0; i < total; i++) {
    const at = randomTargetMinutes(dateKey, i);
    if (at >= RANDOM_WINDOW.end) continue;
    slots.push({ key: `random-${i}`, kind: 'random', at_minutes: at });
  }

  return slots.sort((a, b) => a.at_minutes - b.at_minutes);
}

/** 读当天计划：时间来自纯函数，生成状态来自 proactive_log。 */
export async function readPlan(
  env: Env,
  now: Date = new Date(),
  dateKey: string = dateKeyInBeijing(now),
): Promise<ProactivePlan> {
  const base = buildPlanSlots(dateKey);

  const logged = await env.DB.prepare(
    'SELECT slot_key, status, message_id FROM proactive_log WHERE date_key = ?',
  )
    .bind(dateKey)
    .all<{ slot_key: string; status: PlanStatus; message_id: number | null }>()
    .catch(() => ({ results: [] as Array<{ slot_key: string; status: PlanStatus; message_id: number | null }> }));

  const byKey = new Map((logged.results ?? []).map((r) => [r.slot_key, r]));

  const pausedUntil = await getRuntimeState(env, 'proactive:paused_until').catch(() => null);
  const pausedMs = pausedUntil ? Date.parse(pausedUntil) : Number.NaN;
  const paused = Number.isFinite(pausedMs) && now.getTime() < pausedMs;

  return {
    date: dateKey,
    paused,
    paused_until: pausedUntil ?? null,
    level: (env.PROACTIVE_LEVEL as 'quiet' | 'normal' | 'active') ?? 'normal',
    tolerance_min: PLAN_TOLERANCE_MIN,
    notify_deadline_min: PLAN_NOTIFY_DEADLINE_MIN,
    slots: base.map((s) => {
      const row = byKey.get(s.key);
      return {
        key: s.key,
        kind: s.kind,
        at: formatMinutes(s.at_minutes),
        at_minutes: s.at_minutes,
        generated: Boolean(row),
        status: row?.status ?? null,
        message_id: row?.message_id ?? null,
      };
    }),
  };
}

/** 两个固定时段的窗口边界，供客户端兜底（计划拉取失败时用）。 */
export function fallbackPlanTimes(): Array<{ key: string; kind: PlanKind; at: string }> {
  return [
    { key: 'morning', kind: 'morning', at: formatMinutes(PROACTIVE_WINDOWS.morning.start + 5) },
    { key: 'evening', kind: 'evening', at: formatMinutes(PROACTIVE_WINDOWS.evening.start + 5) },
  ];
}
