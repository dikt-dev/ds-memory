/**
 * 生活系统的读写（P0-B）。
 *
 * 表结构见 migrations/014-life.sql。这里只做三件事：
 *   读当天的计划 / 写当天的计划 / 拿最近 14 天的使用记录给反重复用。
 *
 * 时间一律按北京时间算。凌晨 0–2 点仍属于「前一天」的计划（她还没睡），
 * 所以时间轴用「超过 1440 的分钟」表示，别把 01:00 当成新一天的 60。
 */
import type { Env } from '../types';
import { buildDay, type DayPlan, type PlannedActivity } from './planner';
import { ACTIVITIES } from './pool';
import type { DayEnv } from './types';

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

/** 北京时间下的日期键 'YYYY-MM-DD'。 */
export function beijingDateKey(now = new Date()): string {
  return new Date(now.getTime() + BEIJING_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * 当前属于哪一天的「生活日」，以及在这一天里的第几分钟。
 *
 * 凌晨 0–2 点算前一天，因为那会儿她还没睡（睡觉是次日 02:00）。
 */
export function lifeClock(now = new Date()): { dateKey: string; minute: number } {
  const bj = new Date(now.getTime() + BEIJING_OFFSET_MS);
  const minutes = bj.getUTCHours() * 60 + bj.getUTCMinutes();
  if (minutes < 2 * 60) {
    const prev = new Date(bj.getTime() - 24 * 60 * 60 * 1000);
    return { dateKey: prev.toISOString().slice(0, 10), minute: minutes + 24 * 60 };
  }
  return { dateKey: bj.toISOString().slice(0, 10), minute: minutes };
}

export interface DayRow {
  date_key: string;
  location: string;
  at_home: number;
  mood_seed: number;
  health: number;
  weather: string;
  temp_c: number;
  plan_json: string;
  generated_at: string;
}

export interface ActivityRow {
  date_key: string;
  start_min: number;
  end_min: number;
  unit_id: string;
  kind: string;
  title: string;
  place: string | null;
  interruptible: number;
  reply_chance: number;
  mood_delta: number;
}

/** 读一天的计划；没有就返回 null。 */
export async function getDayPlan(
  env: Env,
  dateKey: string,
): Promise<{ day: DayRow; activities: ActivityRow[] } | null> {
  const day = await env.DB.prepare('SELECT * FROM ai_day WHERE date_key = ?')
    .bind(dateKey)
    .first<DayRow>();
  if (!day) return null;
  const rows = await env.DB.prepare(
    'SELECT * FROM ai_activity WHERE date_key = ? ORDER BY start_min ASC',
  )
    .bind(dateKey)
    .all<ActivityRow>();
  return { day, activities: rows.results ?? [] };
}

/** 写一天的计划（幂等：先删后插，同一天重算不会留下两份）。 */
export async function saveDayPlan(
  env: Env,
  input: {
    plan: DayPlan;
    env: DayEnv;
    location: string;
    moodSeed: number;
    health?: number;
    generatedAt?: string;
  },
): Promise<void> {
  const { plan, env: dayEnv } = input;
  const statements = [
    env.DB.prepare(
      `INSERT INTO ai_day (date_key, location, at_home, mood_seed, health, weather, temp_c, plan_json, generated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(date_key) DO UPDATE SET
         location = excluded.location,
         at_home = excluded.at_home,
         mood_seed = excluded.mood_seed,
         health = excluded.health,
         weather = excluded.weather,
         temp_c = excluded.temp_c,
         plan_json = excluded.plan_json,
         generated_at = excluded.generated_at`,
    ).bind(
      plan.date,
      input.location,
      dayEnv.atHome ? 1 : 0,
      input.moodSeed,
      input.health ?? 100,
      dayEnv.weather,
      dayEnv.tempC,
      JSON.stringify(plan),
      input.generatedAt ?? new Date().toISOString(),
    ),
    env.DB.prepare('DELETE FROM ai_activity WHERE date_key = ?').bind(plan.date),
  ];
  for (const act of plan.activities) {
    const unit = ACTIVITIES.find((u) => u.id === act.unitId);
    statements.push(
      env.DB.prepare(
        `INSERT INTO ai_activity (date_key, start_min, end_min, unit_id, kind, title, place, interruptible, reply_chance, mood_delta)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        plan.date,
        act.start,
        act.end,
        act.unitId,
        unit?.kind ?? 'idle',
        unit?.name ?? act.unitId,
        null,
        unit?.interruptible === false ? 0 : 1,
        unit?.replyChance ?? 0.5,
        unit?.mood ?? 0,
      ),
    );
  }
  await env.DB.batch(statements);
}

/** 最近 N 天用过哪些单元：unitId → 日期数组。反重复用。 */
export async function recentUses(
  env: Env,
  dateKey: string,
  days = 14,
): Promise<Map<string, string[]>> {
  const from = shiftDate(dateKey, -days);
  const rows = await env.DB.prepare(
    'SELECT date_key, unit_id FROM ai_activity WHERE date_key >= ? AND date_key < ? ORDER BY date_key ASC',
  )
    .bind(from, dateKey)
    .all<{ date_key: string; unit_id: string }>();
  const map = new Map<string, string[]>();
  for (const row of rows.results ?? []) {
    const list = map.get(row.unit_id) ?? [];
    list.push(row.date_key);
    map.set(row.unit_id, list);
  }
  return map;
}

/** 日期加减天数，返回 'YYYY-MM-DD'。 */
export function shiftDate(dateKey: string, delta: number): string {
  const d = new Date(dateKey + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/**
 * 没有计划就生成一份并落库。
 *
 * 幂等靠 date_key 主键 + 种子：同一天重复调用结果一致，不需要加锁。
 */
export async function ensureDayPlan(
  env: Env,
  input: {
    dateKey: string;
    env: DayEnv;
    location: string;
    moodSeed?: number;
    health?: number;
    salt?: string;
  },
): Promise<{ day: DayRow; activities: ActivityRow[] }> {
  const existing = await getDayPlan(env, input.dateKey);
  if (existing) return existing;
  const uses = await recentUses(env, input.dateKey);
  const plan = buildDay({
    date: input.dateKey,
    env: input.env,
    recentUses: uses,
    salt: input.salt,
  });
  // 当天基调 = 各段活动 mood 的均值。先只存着：P0 不喂给情绪向量，
  // 等 P2 打开闸门再进 processEmotionTurn 的 environment 通道。
  const moodSeed =
    input.moodSeed ??
    (plan.activities.length > 0
      ? plan.activities.reduce((sum, a) => {
          const unit = ACTIVITIES.find((u) => u.id === a.unitId);
          return sum + (unit?.mood ?? 0);
        }, 0) / plan.activities.length
      : 0);
  await saveDayPlan(env, {
    plan,
    env: input.env,
    location: input.location,
    moodSeed,
    health: input.health,
  });
  const saved = await getDayPlan(env, input.dateKey);
  if (saved) return saved;
  // 极端情况（写库失败）：退化成内存结果，至少不抛
  return {
    day: {
      date_key: input.dateKey,
      location: input.location,
      at_home: input.env.atHome ? 1 : 0,
      mood_seed: input.moodSeed ?? 0,
      health: input.health ?? 100,
      weather: input.env.weather,
      temp_c: input.env.tempC,
      plan_json: JSON.stringify(plan),
      generated_at: new Date().toISOString(),
    },
    activities: plan.activities.map((a: PlannedActivity) => {
      const unit = ACTIVITIES.find((u) => u.id === a.unitId);
      return {
        date_key: input.dateKey,
        start_min: a.start,
        end_min: a.end,
        unit_id: a.unitId,
        kind: unit?.kind ?? 'idle',
        title: unit?.name ?? a.unitId,
        place: null,
        interruptible: unit?.interruptible === false ? 0 : 1,
        reply_chance: unit?.replyChance ?? 0.5,
        mood_delta: unit?.mood ?? 0,
      };
    }),
  };
}

/** 状态栏三档（§7.1）：睡着 / 在忙 / 有空。 */
export type LifeStatus = 'sleeping' | 'busy' | 'free';

export interface NowStatus {
  status: LifeStatus;
  current: ActivityRow | null;
  next: ActivityRow | null;
  health: number;
}

/** 「现在 + 下一段」（§7.2）。 */
export function statusAt(
  activities: ActivityRow[],
  minute: number,
  health = 100,
): NowStatus {
  const sleeping = minute >= 26 * 60 || minute < 9 * 60;
  const hit = activities.find((a) => minute >= a.start_min && minute < a.end_min) ?? null;
  const next = activities.find((a) => a.start_min > minute) ?? null;
  if (sleeping && !hit) return { status: 'sleeping', current: null, next, health };
  if (!hit) return { status: 'free', current: null, next, health };
  return { status: hit.interruptible ? 'free' : 'busy', current: hit, next, health };
}
