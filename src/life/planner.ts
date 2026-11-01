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

/** 睡觉时间：次日 02:00（用超过 1440 的分钟数表示）。 */
export const SLEEP_START = 26 * 60;
/** 起床时间：09:00。 */
export const WAKE_AT = 9 * 60;
/** 一天最多几段活动。多了就显得「一天到晚都在做事」，不像人。 */
export const MAX_ACTIVITIES = 5;

const MEALS = [
  { name: '早餐', start: 9 * 60 + 10, minutes: 40 },
  { name: '午饭', start: 12 * 60 + 30, minutes: 50 },
  { name: '晚饭', start: 19 * 60, minutes: 50 },
];

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
}

/** 骨架空档：三餐和睡觉之间的可用时间。 */
export function dayWindows(): Array<{ start: number; end: number }> {
  const blocks = [
    { start: WAKE_AT, end: MEALS[0].start },
    ...MEALS.map((m) => ({ start: m.start, end: m.start + m.minutes })),
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
  const hot = env.tempC >= 30;
  const has = (tag: string) => unit.tags.includes(tag as ActUnit['tags'][number]);

  if (has('outdoor') && !has('rainy_ok') && rainy) return false;
  if (has('sunny_only') && !sunny) return false;
  if (has('hot_ok') && !hot && has('outdoor') && sunny) return false;
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

/** 往一个空档里装活动，装不下就留白。 */
function fillWindow(
  rng: Rng,
  start: number,
  end: number,
  input: BuildDayInput,
  used: Set<string>,
  budget: number,
): PlannedActivity[] {
  const out: PlannedActivity[] = [];
  let cursor = start;
  while (end - cursor >= 30 && out.length < Math.min(3, budget - out.length)) {
    const free = end - cursor;
    // 关键：不是「把空档填满」，而是「先想这件事大概要花多久」。
    // 只按空档长度配单元，会永远只抽长单元（爬山、游乐园），
    // 60–120 分钟的日常（逛书店、洗衣服、看小说）就永远轮不到。
    // 下限 20 分钟：不然 15–30 分钟的小事（洗碗、浇花、洗澡）永远抽不到。
    const target = rng.chance(0.22) ? free : rng.int(20, Math.min(free, 180));
    const candidates = ACTIVITIES.filter((u) => {
      if (used.has(u.id)) return false;
      if (!tagsOk(u, input.env)) return false;
      if (antiRepeatWeight(u.id, input.date, input.recentUses) <= 0) return false;
      return u.min <= target && u.max * 1.2 >= target;
    });
    const picked = rng.weighted(candidates, (u) =>
      u.weight * antiRepeatWeight(u.id, input.date, input.recentUses),
    );
    if (!picked) break;
    const room = Math.min(free, SLEEP_START - cursor);
    if (room < picked.min) break;
    const span = Math.min(room, rng.int(picked.min, Math.max(picked.min, picked.max)));
    out.push({ unitId: picked.id, start: cursor, end: cursor + span });
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
  for (const w of dayWindows()) {
    if (activities.length >= MAX_ACTIVITIES) break;
    activities.push(...fillWindow(rng, w.start, w.end, input, used, MAX_ACTIVITIES - activities.length));
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
