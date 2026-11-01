/**
 * 一天的生成：骨架 → 空档 → 装填（§5.2.2）。
 *
 * 三步刻意分开，因为每一步都能单独测：
 *   1. 骨架固定（睡觉、三餐），不随机
 *   2. 空档由骨架算出来，也不随机
 *   3. 只有「往空档里装什么」是随机的，而且必须可复现
 */
import { ACTIVITIES, BY_ID } from './pool';
import { makeRng, type Rng } from './seed';
import type { ActUnit, DayEnv } from './types';
import type { Recipe } from './recipes';

/** 睡觉时间：次日 01:00（用超过 1440 的分钟数表示）。 */
export const SLEEP_START = 25 * 60;
/** 起床时间：08:00。 */
export const WAKE_AT = 8 * 60;
/** 一天最多几段活动。多了就显得「一天到晚都在做事」，不像人。 */
export const MAX_ACTIVITIES = 4;

/** 三餐：不是背景板，是日程里真会出现的一段（「08:20 早餐」）。 */
export const MEALS = [
  { name: '早餐', start: 8 * 60 + 10, minutes: 40 },
  { name: '午饭', start: 12 * 60 + 30, minutes: 50 },
  { name: '晚饭', start: 19 * 60, minutes: 50 },
];
/** 三餐最多 3 段，不占 MAX_ACTIVITIES 的名额（吃饭不是「活动」）。 */
export const MAX_MEALS = MEALS.length;
/** 加餐最多 2 段（下午茶、夜宵），同样不占名额。 */
export const MAX_EXTRAS = 2;

export interface PlannedActivity {
  unitId: string;
  start: number;
  end: number;
}

export interface DayPlan {
  date: string;
  seed: string;
  activities: PlannedActivity[];
}

export interface BuildDayInput {
  /** 北京时间 'YYYY-MM-DD'，同时用作种子的一部分 */
  date: string;
  env: DayEnv;
  /** 最近 14 天用过哪些单元：unitId → 日期数组 */
  recentUses?: Map<string, string[]>;
  /** 额外种子，出问题时换个值就能重抽 */
  salt?: string;
  /** 特殊日配方（生病/摆烂/大扫除/通宵）。不传就是普通的一天。 */
  recipe?: Recipe | null;
}

/** 骨架空档：三餐和睡觉之间的可用时间。 */
export function dayWindows(wakeAt = WAKE_AT): Array<{ start: number; end: number }> {
  // 早饭跟着起床时间走：晚起半小时，就不会 09:10 吃早饭
  const breakfast = Math.max(MEALS[0].start, wakeAt + 10);
  const blocks = [
    { start: wakeAt, end: breakfast },
    { start: breakfast, end: breakfast + MEALS[0].minutes },
    ...MEALS.slice(1).map((m) => ({ start: m.start, end: m.start + m.minutes })),
  ];
  const windows: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < blocks.length - 1; i += 1) {
    const start = blocks[i].end;
    const end = blocks[i + 1].start;
    if (end - start >= 30) windows.push({ start, end });
  }
  const last = blocks[blocks.length - 1].end;
  if (SLEEP_START - last >= 30) windows.push({ start: last, end: SLEEP_START });

  // 只有超过 400 分钟才切。切太碎会让 240–420 分钟的爬山、游乐园永远抽不到。
  const out: Array<{ start: number; end: number }> = [];
  for (const w of windows) {
    if (w.end - w.start > 400) {
      const mid = w.start + Math.floor((w.end - w.start) / 2);
      out.push({ start: w.start, end: mid }, { start: mid, end: w.end });
    } else out.push(w);
  }
  return out;
}

/** 天气/在家 是否允许这个单元。 */
export function tagsOk(unit: ActUnit, env: DayEnv): boolean {
  const rainy = env.weather === 'rain' || env.weather === 'snow';
  const sunny = env.weather === 'sunny';
  const has = (tag: string) => unit.tags.includes(tag as ActUnit['tags'][number]);

  if (has('outdoor') && !has('rainy_ok') && rainy) return false;
  if (has('sunny_only') && !sunny) return false;
  if (has('cold_ok') && env.tempC > 26) return false;
  if (!env.atHome && !has('outdoor')) return false;
  return true;
}

/**
 * 反重复权重（§5.2.3）。
 *
 * 3 天内用过 ×0.35；7 天内两次 ×0.15；14 天内三次直接禁用（返回 0）。
 */
export function antiRepeatWeight(
  unitId: string,
  date: string,
  recentUses?: Map<string, string[]>,
): number {
  const uses = recentUses?.get(unitId);
  if (!uses || uses.length === 0) return 1;
  const dayMs = 24 * 60 * 60 * 1000;
  const now = Date.parse(date + 'T00:00:00+08:00');
  const days = uses
    .map((d) => (now - Date.parse(d + 'T00:00:00+08:00')) / dayMs)
    .filter((n) => Number.isFinite(n) && n >= 0);
  const within = (n: number) => days.filter((d) => d <= n).length;
  if (within(14) >= 3) return 0;
  if (within(7) >= 2) return 0.15;
  if (within(3) >= 1) return 0.35;
  return 1;
}

/**
 * 单元级规则：天气依赖、时段、冷却。
 *
 * 池子里的 tags 只表达「室内的/户外的/怕雨的」，表达不了
 * 「看雪得下雪」「夜宵不能出现在下午一点」「大扫除一个月一次」。
 * 这些不写进池子（你改池子只该改内容），写在这张表里。
 */
interface UnitRule {
  /** 只在这些天气里出现 */
  weather?: string[];
  /** 时段范围（分钟，可以多段） */
  starts?: Array<[number, number]>;
  minTemp?: number;
  maxTemp?: number;
  /** 冷却：N 天内用过就不再出现 */
  cooldownDays?: number;
  /** 只在这几天出现（0=周日 … 6=周六）。通宵追番只排周五周六。 */
  weekdays?: number[];
}

/** 出门类活动不该在夜里安排。默认全天可排，只显式限制需要限制的。 */
const NIGHT_FREE = new Set(['morning', 'day', 'dusk']);
const UNIT_BANDS: Record<string, string[]> = {
  outing_mall: ['morning', 'day', 'dusk'],
  outing_park: ['morning', 'day', 'dusk'],
  outing_museum: ['day', 'dusk'],
  outing_bookstore: ['day', 'dusk'],
  outing_swim: ['morning', 'day'],
  outing_haircut: ['morning', 'day'],
  short_trip_hike: ['morning', 'day'],
  short_trip_amusement: ['day'],
  short_trip_museum: ['day'],
  short_trip_hotspring: ['day', 'dusk'],
  short_trip_movie: ['dusk'],
  clean_deep: ['morning', 'day'],
};

function bandAt(minute: number): string {
  const m = ((minute % 1440) + 1440) % 1440;
  if (m >= 8 * 60 && m < 11 * 60) return 'morning';
  if (m >= 11 * 60 && m < 17 * 60 + 30) return 'day';
  if (m >= 17 * 60 + 30 && m < 21 * 60) return 'dusk';
  return 'night';
}

function bandOk(unitId: string, minute: number): boolean {
  const allowed = UNIT_BANDS[unitId];
  if (!allowed) return true;
  const band = bandAt(minute);
  if (!allowed.includes(band)) return false;
  // 傍晚开的头，别让它一路拖到深夜
  return band !== 'night' || NIGHT_FREE.has(band);
}

const UNIT_RULES: Record<string, UnitRule> = {
  snow_watch: { weather: ['snow'] },
  rainy_window: { weather: ['rain', 'snow'] },
  summer_ice: { minTemp: 26 },
  sunny_balcony: { weather: ['sunny'], starts: [[9 * 60, 16 * 60]] },
  // 通宵只排在周五、周六——周三凌晨四点还在追番，第二天上班的人设崩了
  anime_marathon: { starts: [[19 * 60 + 30, 25 * 60]], cooldownDays: 14, weekdays: [5, 6] },
  // 大扫除是白天的事：晚上八点开始拖地不像人，也吵到邻居
  clean_deep: { cooldownDays: 21, starts: [[8 * 60, 17 * 60 + 30]] },
  short_trip_hike: { cooldownDays: 14 },
  short_trip_amusement: { cooldownDays: 21 },
  short_trip_hotspring: { cooldownDays: 14 },
  short_trip_museum: { cooldownDays: 14 },
  short_trip_movie: { cooldownDays: 14 },
  outing_haircut: { cooldownDays: 30 },
  outing_swim: { minTemp: 24, maxTemp: 40, cooldownDays: 30 },
  meal_night: { starts: [[20 * 60 + 30, 25 * 60]] },
  // 「能忍受热」不等于「必须热」：hot_ok 以前被当成硬门槛，
  // 结果公园（60–150 分钟）只在 ≥30℃ 的晴天出现，九月十月一次都没有。
  // 游泳是真的怕冷，单独给个温度下限。
  meal_snack: { starts: [[14 * 60, 18 * 60 + 30]] },
  meal_normal: { starts: [[7 * 60 + 30, 13 * 60 + 30], [17 * 60, 20 * 60]] },
  meal_takeout: { starts: [[7 * 60 + 30, 13 * 60 + 30], [17 * 60, 20 * 60]] },
  idle_nap: { starts: [[11 * 60, 16 * 60]] },
  night_bath: { starts: [[20 * 60 + 30, 25 * 60]] },
  night_reading: { starts: [[20 * 60 + 30, 25 * 60]] },
  night_music: { starts: [[20 * 60 + 30, 25 * 60]] },
  night_tidy: { starts: [[20 * 60, 24 * 60]] },
  night_write: { starts: [[21 * 60, 25 * 60]] },
};

/**
 * 天气偏好：晴天更愿意出门，阴雨天更愿意待着。
 *
 * 没有这一条的时候，30 天里 3 个晴天全被她用来在家打游戏——
 * 不是数据坏了，是池子里「出门」和「在家」的权重一样高，天气就白接了。
 */
function weatherBias(unit: ActUnit, env: DayEnv): number {
  const outdoor = unit.tags.includes('outdoor');
  const sunny = env.weather === 'sunny';
  if (outdoor && sunny && env.tempC >= 14 && env.tempC <= 26) return 2.2;
  // 晴天但只有 10℃ 左右，也还是想出去晒晒，只是没那么大劲
  if (outdoor && sunny && env.tempC >= 6) return 1.8;
  if (outdoor && env.weather === 'cloudy') return 1.2;
  if (!outdoor && (env.weather === 'rain' || env.weather === 'snow')) return 1.3;
  return 1;
}

/** 这条单元在「这个开始时间」合不合规矩。 */
function ruleOk(unitId: string, start: number, env: DayEnv, date: string, recentUses?: Map<string, string[]>): boolean {
  if (!bandOk(unitId, start)) return false;
  const rule = UNIT_RULES[unitId];
  if (!rule) return true;
  if (rule.weather && !rule.weather.includes(env.weather)) return false;
  if (rule.minTemp !== undefined && env.tempC < rule.minTemp) return false;
  if (rule.maxTemp !== undefined && env.tempC > rule.maxTemp) return false;
  const atMin = ((start % 1440) + 1440) % 1440;
  if (rule.starts && !rule.starts.some(([a, b]) => atMin >= (a % 1440) && atMin <= (b % 1440))) {
    // 跨午夜的时间段（如 20:00–02:00）单独判断
    const spansMidnight = rule.starts.some(([a, b]) => b > 1440 && (atMin >= (a % 1440) || atMin <= (b % 1440)));
    if (!spansMidnight) return false;
  }
  if (rule.weekdays) {
    const utc = Date.parse(date + 'T00:00:00Z');
    const wd = Number.isFinite(utc) ? new Date(utc).getUTCDay() : -1;
    if (!rule.weekdays.includes(wd)) return false;
  }
  if (rule.cooldownDays && recentUses) {
    const uses = recentUses.get(unitId) ?? [];
    const nowMs = Date.parse(date + 'T00:00:00+08:00');
    const tooSoon = uses.some((d) => {
      const diff = (nowMs - Date.parse(d + 'T00:00:00+08:00')) / 86400000;
      return diff >= 0 && diff <= rule.cooldownDays!;
    });
    if (tooSoon) return false;
  }
  return true;
}

/**
 * 给三餐各挑一个「吃饭类」单元。
 *
 * 之前三餐只是背景块：不许放活动，而吃饭类单元又不在任何空档里能落地，
 * 结果她 60 天只吃过一顿饭。现在三餐是真正的窗口，只放 kind==='meal' 的单元。
 * 挑不到就留空——宁可这一天没记录，也不硬塞一段「夜宵」当早饭。
 */
function pickMeal(
  rng: Rng,
  slot: { name: string; start: number; minutes: number },
  input: BuildDayInput,
  used: Set<string>,
): PlannedActivity | null {
  const start = slot.start + rng.int(0, 11);
  const room = slot.start + slot.minutes - start;
  const candidates = ACTIVITIES.filter(
    (u) =>
      u.kind === 'meal' &&
      u.min <= room &&
      Math.min(u.max, room) >= 20 &&
      ruleOk(u.id, start, input.env, input.date, input.recentUses),
  );
  // 兜底：规则挑不出（起床太晚、时段卡住）时，放宽到「能塞进这段时间的吃饭单元」。
  // 不为了一顿饭把整天的种子重抽——少一顿早饭比少一整天空档更难看。
  const fallback = candidates.length > 0 ? candidates : ACTIVITIES.filter((u) => u.kind === 'meal' && u.min <= room);
  if (fallback.length === 0) return null;
  // 今天还没吃过的优先，但允许重复：池子里能当正餐的只有两个单元，
  // 硬要求一天三顿各不相同，结果是晚饭永远轮空。
  const fresh = fallback.filter((u) => !used.has(u.id));
  const picked = rng.pick(fresh.length > 0 ? fresh : fallback) as ActUnit;
  const minutes = Math.min(room, Math.max(picked.min, Math.min(picked.max, room)));
  used.add(picked.id);
  return { unitId: picked.id, start, end: start + minutes };
}

/** 往一个空档里装活动，装不下就留白。 */
function fillWindow(
  rng: Rng,
  start: number,
  end: number,
  input: BuildDayInput,
  used: Set<string>,
  budget: number,
  lazy = false,
  socialUsed = 0,
  kinds?: string[],
): PlannedActivity[] {
  const out: PlannedActivity[] = [];
  let cursor = start;
  while (end - cursor >= 30 && out.length < Math.min(3, budget - out.length)) {
    const free = end - cursor;
    // 关键：不是「把空档填满」，而是「先想这件事大概要花多久」。
    // 只按空档长度配单元，会永远只抽长单元（爬山、游乐园），
    // 60–120 分钟的日常（逛书店、洗衣服、看小说）就永远轮不到。
    // 下限 20 分钟：不然 15–30 分钟的小事（洗碗、浇花、洗澡）永远抽不到。
    // 关键：不是「把空档填满」，而是「先想这件事大概要花多久」。
    // 只按空档长度配单元，会永远只抽长单元（爬山、游乐园），
    // 60–120 分钟的日常（逛书店、洗衣服、看小说）就永远轮不到。
    // 候选为空时必须**降低目标时长重试**，否则一个抽不到的长目标会让整个下午空着。
    // 上限从 180 提到 240，并加了 180 这一档：
    // 爬山（180–360）和游乐园（240–420）之前永远抽不到，因为目标时长封顶 180。
    // 「填满整个空档」的概率从 22% 提到 30%：60 天里一次公园都没去，不像人。
    const targets = [
      rng.chance(0.3) ? free : rng.int(20, Math.min(free, 240)),
      180,
      90,
      60,
      40,
      25,
    ];
    let picked: (typeof ACTIVITIES)[number] | null = null;
    for (const target of targets) {
      if (target > free) continue;
      const candidates = ACTIVITIES.filter((u) => {
        if (used.has(u.id)) return false;
        // 配方日只允许那几类（生病在家只躺着吃饭、大扫除日只打扫）
        if (kinds && !kinds.includes(u.kind)) return false;
        // 摆烂日只躺着、吃饭、找人聊两句，不出门做事
        if (lazy && !(u.kind === 'idle' || u.kind === 'meal' || u.kind === 'social')) return false;
        // 一天最多一次社交：她有朋友，但不是每天都有局
        if (u.kind === 'social' && socialUsed >= 1) return false;
        if (!tagsOk(u, input.env)) return false;
        if (antiRepeatWeight(u.id, input.date, input.recentUses) <= 0) return false;
        if (!ruleOk(u.id, cursor, input.env, input.date, input.recentUses)) return false;
        return u.min <= target && u.max * 1.2 >= target;
      });
      picked = rng.weighted(candidates, (u) =>
        u.weight * weatherBias(u, input.env) * antiRepeatWeight(u.id, input.date, input.recentUses),
      );
      if (picked) break;
    }
    if (!picked) break;
    const room = Math.min(free, SLEEP_START - cursor);
    if (room < picked.min) break;
    const span = Math.min(room, rng.int(picked.min, Math.max(picked.min, picked.max)));
    out.push({ unitId: picked.id, start: cursor, end: cursor + span });
    if (picked.kind === 'social') socialUsed += 1;
    used.add(picked.id);
    cursor += span + rng.int(5, 20);
  }
  return out;
}

/** 生成一天。同样的 date + salt 一定给出同样的结果。 */
export function buildDay(input: BuildDayInput): DayPlan {
  const seed = `${input.date}|${input.env.weather}|${input.env.atHome ? 'home' : 'out'}|${input.salt ?? ''}`;
  const rng = makeRng(seed);
  const used = new Set<string>();
  const activities: PlannedActivity[] = [];

  // 特殊日配方优先于普通装填；没有配方时按普通日子排。
  // 没有这层的话，每天都排满 4 段——她不像人，像排班表。
  const recipe = input.recipe ?? null;
  const wakeAt = recipe ? recipe.wakeAt : WAKE_AT + rng.int(-20, 50);
  const budget = recipe ? recipe.budget : MAX_ACTIVITIES;
  const lazy = recipe?.id === 'lazy';
  let socialUsed = 0;

  // 三餐先落：它们占固定时段，后面的活动只能填空档
  const breakfastStart = Math.max(MEALS[0].start, wakeAt + 10);
  const slots = [{ ...MEALS[0], start: breakfastStart }, ...MEALS.slice(1)];
  for (const slot of slots) {
    const meal = pickMeal(rng, slot, input, used);
    if (meal) activities.push(meal);
  }

  // 名额只算「活动」：三餐和加餐都在 activities 里，不能拿 length 当已用名额
  let actCount = 0;
  for (const w of dayWindows(wakeAt)) {
    if (actCount >= budget) break;
    const filled = fillWindow(rng, w.start, w.end, input, used, budget - actCount, lazy, socialUsed, recipe?.kinds);
    actCount += filled.length;
    socialUsed += filled.filter((a) => ACTIVITIES.find((u) => u.id === a.unitId)?.kind === 'social').length;
    activities.push(...filled);
  }
  // 加餐：下午茶和夜宵不是每天都有，但一个月总有几次。
  // 它们是 meal 类，不占活动名额，只要那个点空着就放。
  const extras: Array<{ id: string; at: number; width: number; chance: number }> = [
    { id: 'meal_snack', at: 15 * 60 + 40, width: 45, chance: 0.35 },
    { id: 'meal_night', at: 22 * 60 + 30, width: 70, chance: 0.22 },
  ];
  for (const extra of extras) {
    if (!rng.chance(extra.chance)) continue;
    const at = extra.at + rng.int(0, 20);
    const unit = ACTIVITIES.find((u) => u.id === extra.id);
    if (!unit || !ruleOk(unit.id, at, input.env, input.date, input.recentUses)) continue;
    // 撞车要按「实际会占多久」算。以前拿 unit.min 判断、拿 width 落地：
    // 下午茶最短 15 分钟但一摆 45 分钟，于是 15:57 的茶和 16:12 的种田叠了 15 分钟。
    const minutes = Math.min(extra.width, unit.max);
    const busy = activities.some((a) => at < a.end && at + minutes > a.start);
    if (busy) continue;
    activities.push({ unitId: unit.id, start: at, end: at + minutes });
  }

  activities.sort((a, b) => a.start - b.start);
  return { date: input.date, seed, activities };
}

/** 校验不过就换盐重抽，最多 3 次（§5.5）。 */
export function buildDayUntilValid(
  input: BuildDayInput,
  validate: (plan: DayPlan) => Array<{ rule: string }>,
): DayPlan {
  let plan = buildDay(input);
  for (let attempt = 0; attempt < 3 && validate(plan).length > 0; attempt += 1) {
    plan = buildDay({ ...input, salt: `${input.salt ?? ''}#retry${attempt + 1}` });
  }
  return plan;
}

/** 把计划读成人话，方便展示/排查。 */
export function describeDay(plan: DayPlan): Array<{ at: string; name: string; minutes: number }> {
  const fmt = (m: number) => {
    const day = Math.floor(m / 1440);
    const mm = m % 1440;
    const hh = String(Math.floor(mm / 60)).padStart(2, '0');
    const mi = String(mm % 60).padStart(2, '0');
    return `${day > 0 ? '次日' : ''}${hh}:${mi}`;
  };
  return plan.activities.map((a) => ({
    at: fmt(a.start),
    name: BY_ID.get(a.unitId)?.name ?? a.unitId,
    minutes: a.end - a.start,
  }));
}
