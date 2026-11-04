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
import { sceneFor, socialCastFor, socialPartnerFor, withCast } from './residents';
import { placeFor } from './place';
import type { DayEnv } from './types';
import { RECIPES, healthForDay, pickRecipe, type Recipe } from './recipes';
import { festivalOn } from './festivals';
import { makeRng } from './seed';
import { dayIndexOnTrip, maybeStartTrip, readTrip, writeTrip, TRIP_CITIES, type Trip } from './travel';

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

/** 北京时间下的日期键 'YYYY-MM-DD'。 */
export function beijingDateKey(now = new Date()): string {
  return new Date(now.getTime() + BEIJING_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * 当前属于哪一天的「生活日」，以及在这一天里的第几分钟。
 *
 * 凌晨 0–1 点算前一天，因为那会儿她还没睡（睡觉是次日 01:00）。
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

/**
 * 当天和谁在一起：只记 core（会排单元的那个）。
 * ambient 只做背景音，不进库——不然每天都能「发生」一场偶遇，很假。
 */
/** 当天的社交记录：核心人 + 一起的人 + 场景。没有社交就是 null。 */
export function peopleFor(activities: { unitId: string }[], dateKey: string): string | null {
  const social = activities.find((a) => ACTIVITIES.find((x) => x.id === a.unitId)?.kind === 'social');
  if (!social) return null;
  const cast = socialCastFor(dateKey, social.unitId);
  return JSON.stringify({
    core: cast[0]!.id,
    cast: cast.map((x) => x.id),
    scene: sceneFor(social.unitId, dateKey),
  });
}

export interface DayRow {
  date_key: string;
  recipe?: string | null;
  location: string;
  at_home: number;
  mood_seed: number;
  health: number;
  weather: string;
  temp_c: number;
  plan_json: string;
  generated_at: string;
  /** 当天出现的社交对象 JSON（{"core":"dou-bao"}），空着=没有住户 */
  people?: string | null;
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
    recipe?: string | null;
    generatedAt?: string;
  },
): Promise<void> {
  const { plan, env: dayEnv } = input;
  const statements = [
    env.DB.prepare(
      `INSERT INTO ai_day (date_key, location, at_home, mood_seed, health, weather, temp_c, plan_json, generated_at, recipe, people)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(date_key) DO UPDATE SET
         location = excluded.location,
         at_home = excluded.at_home,
         mood_seed = excluded.mood_seed,
         health = excluded.health,
         weather = excluded.weather,
         temp_c = excluded.temp_c,
         plan_json = excluded.plan_json,
         generated_at = excluded.generated_at,
         recipe = excluded.recipe,
         people = excluded.people`,
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
      input.recipe ?? null,
      peopleFor(plan.activities, plan.date),
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
        unit?.kind === 'social'
          ? withCast(unit?.name ?? '', socialCastFor(plan.date, act.unitId))
          : unit?.name ?? act.unitId,
        unit?.kind === 'social' ? sceneFor(act.unitId, plan.date) : placeFor(act.unitId, dayEnv.atHome),
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
  // 特殊日 + 健康度：都要看前几天的记录，所以先查历史再生成
  const history = await recipeHistory(env, input.dateKey);
  const prev = await previousHealth(env, input.dateKey);
  const health = healthForDay({
    yesterdayHealth: prev ?? 100,
    sickToday: false,
    daysSinceSick: history.daysSinceSick,
  });

  // 旅行优先于其他配方：在路上的日子不生病、不摆烂、不打扫。
  const { recipe, trip, dayEnv, location } = await resolveTravel(env, {
    dateKey: input.dateKey,
    env: input.env,
    location: input.location,
    health,
    history,
  });

  const plan = buildDay({
    date: input.dateKey,
    env: dayEnv,
    recentUses: uses,
    salt: input.salt,
    recipe,
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
    env: dayEnv,
    location,
    moodSeed,
    health: recipe?.health ?? health,
    recipe: recipe?.id ?? null,
  });
  const saved = await getDayPlan(env, input.dateKey);
  if (saved) return saved;
  // 极端情况（写库失败）：退化成内存结果，至少不抛
  return {
    day: {
      date_key: input.dateKey,
      location,
      at_home: dayEnv.atHome ? 1 : 0,
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
        title: unit?.kind === 'social'
          ? withCast(unit?.name ?? '', socialCastFor(input.dateKey, a.unitId))
          : unit?.name ?? a.unitId,
        place: unit?.kind === 'social' ? sceneFor(a.unitId, input.dateKey) : placeFor(a.unitId, dayEnv.atHome),
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
  /** 今天是什么日子（sick/deepclean/marathon…），普通日子为 null */
  recipe?: string | null;
}

/** 「现在 + 下一段」（§7.2）。 */
export function statusAt(
  activities: ActivityRow[],
  minute: number,
  health = 100,
): NowStatus {
  const sleeping = minute >= 25 * 60 || minute < 8 * 60;
  const hit = activities.find((a) => minute >= a.start_min && minute < a.end_min) ?? null;
  const next = activities.find((a) => a.start_min > minute) ?? null;
  if (sleeping && !hit) return { status: 'sleeping', current: null, next, health };
  if (!hit) return { status: 'free', current: null, next, health };
  // 「在忙」= 这段时间她本来就不看手机，由活动类型查表决定（设计原则 5）：
  //   · interruptible=false 是硬性（洗澡、睡觉这类）
  //   · reply_chance < 0.2 是软性（逛街、剪头发、健身……本来就不太可能掏手机）
  // 只看 interruptible 的旧写法，池子里只有洗澡和看电影标了 false，
  // 于是整天都是「有空」——这就是她永远秒回的根子。
  const busy = hit.interruptible === 0 || (hit.reply_chance ?? 1) < 0.2;
  return { status: busy ? 'busy' : 'free', current: hit, next, health };
}

/**
 * 回复前故意等一会儿。
 *
 * 秒回是机器的特征，不是人的：她洗澡、看电影、在睡觉的时候，本来就不该立刻回。
 * 这个延迟加在服务端，网页和 App 都不用改；等待期间客户端本来就显示「正在回复…」。
 * 数值是手感，不是物理：忙的时候 6–18 秒，睡着 20–60 秒，闲着一两秒。
 */
export function replyDelayMs(status: LifeStatus, rand: () => number = Math.random): number {
  if (status === 'busy') return 6000 + Math.round(rand() * 12000);
  if (status === 'sleeping') return 20000 + Math.round(rand() * 40000);
  return 800 + Math.round(rand() * 2500);
}

/** 最近一次「生病 / 大扫除 / 通宵」距今天多少天。冷却和康复曲线都靠它。 */
export async function recipeHistory(
  env: Env,
  dateKey: string,
): Promise<{ daysSinceSick: number | null; daysSinceDeepclean: number | null; daysSinceMarathon: number | null }> {
  const rows = await env.DB.prepare(
    `SELECT recipe, MAX(date_key) AS last FROM ai_day
     WHERE recipe IN ('sick', 'deepclean', 'marathon') AND date_key < ?
     GROUP BY recipe`,
  )
    .bind(dateKey)
    .all<{ recipe: string; last: string }>()
    .catch(() => null);
  const gap = (recipe: string): number | null => {
    const hit = (rows?.results ?? []).find((r) => r.recipe === recipe);
    if (!hit?.last) return null;
    const diff = (Date.parse(dateKey + 'T00:00:00+08:00') - Date.parse(hit.last + 'T00:00:00+08:00')) / 86400000;
    return Number.isFinite(diff) ? Math.round(diff) : null;
  };
  return { daysSinceSick: gap('sick'), daysSinceDeepclean: gap('deepclean'), daysSinceMarathon: gap('marathon') };
}

/** 前一天的健康度；没有记录就当 100。 */
export async function previousHealth(env: Env, dateKey: string): Promise<number | null> {
  const row = await env.DB.prepare(
    'SELECT health FROM ai_day WHERE date_key < ? ORDER BY date_key DESC LIMIT 1',
  )
    .bind(dateKey)
    .first<{ health: number }>()
    .catch(() => null);
  return row ? row.health : null;
}

/**
 * 决定今天在不在旅行、要不要出发、还是刚回来。
 *
 * 旅行期间：地点是外地、at_home=0；回来那天是回家日（不进池子，只收拾、躺）。
 */
async function resolveTravel(
  env: Env,
  input: {
    dateKey: string;
    env: DayEnv;
    location: string;
    health: number;
    history: { daysSinceSick: number | null; daysSinceDeepclean: number | null; daysSinceMarathon: number | null };
  },
): Promise<{ recipe: Recipe | null; trip: Trip | null; dayEnv: DayEnv; location: string }> {
  const trip = await readTrip(env);
  if (trip) {
    const index = dayIndexOnTrip(trip, input.dateKey);
    if (index !== null) {
      return {
        recipe: RECIPES.trip,
        trip,
        dayEnv: { ...input.env, atHome: false },
        location: trip.city,
      };
    }
    // 行程结束：今天是回家日，顺手把行程清掉
    const endDate = shiftDate(trip.start, trip.days - 1);
    if (input.dateKey === shiftDate(endDate, 1)) {
      await writeTrip(env, null);
      return { recipe: RECIPES.homecoming, trip: null, dayEnv: input.env, location: input.location };
    }
    // 已经过去很久的残留行程，清掉
    if (Date.parse(input.dateKey) > Date.parse(endDate)) await writeTrip(env, null);
  }

  // 大节日（除夕/春节/国庆）当天直接出发：这些日子是她会专门空出来的，
  // 不该由 1.2% 的骰子决定。天数仍按 2–3 天走现成的行程口径。
  const bigFest = festivalOn(input.dateKey);
  // 除夕不出门：这顿年夜饭得在家吃。初一才走。
  if (bigFest?.size === 'big' && bigFest.id !== 'chuxi') {
    const rng = makeRng(`festival-trip|${input.dateKey}`);
    const trip: Trip = { city: rng.pick(TRIP_CITIES), start: input.dateKey, days: rng.int(2, 3) };
    await writeTrip(env, trip);
    return { recipe: RECIPES.trip, trip, dayEnv: { ...input.env, atHome: false }, location: trip.city };
  }

  // 没在旅行：看看今天要不要出发。生病/健康度低的日子不出发。
  const historyTrip = await lastTripEnd(env);
  const started =
    input.history.daysSinceSick !== 0
      ? maybeStartTrip({
          dateKey: input.dateKey,
          daysSinceLastTrip: historyTrip,
          atHome: input.env.atHome,
          health: input.health,
        })
      : null;
  if (started) {
    await writeTrip(env, started);
    return {
      recipe: RECIPES.trip,
      trip: started,
      dayEnv: { ...input.env, atHome: false },
      location: started.city,
    };
  }

  const choice = pickRecipe(input.dateKey, input.history);
  return { recipe: choice.recipe, trip: null, dayEnv: input.env, location: input.location };
}

/** 上次旅行回来距今多少天（行程存在 KV，历史在 ai_day 的 recipe='trip'）。 */
async function lastTripEnd(env: Env, dateKey?: string): Promise<number | null> {
  const row = await env.DB.prepare(
    "SELECT MAX(date_key) AS last FROM ai_day WHERE recipe = 'trip' AND date_key < ?",
  )
    .bind(dateKey ?? beijingDateKey())
    .first<{ last: string | null }>()
    .catch(() => null);
  if (!row?.last) return null;
  const diff =
    (Date.parse(beijingDateKey() + 'T00:00:00+08:00') - Date.parse(row.last + 'T00:00:00+08:00')) / 86400000;
  return Number.isFinite(diff) ? Math.round(diff) : null;
}
