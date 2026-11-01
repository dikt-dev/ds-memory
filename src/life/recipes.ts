/**
 * 特殊日配方（P3 / activity-pool.md §十一）。
 *
 * 作用：让「今天一整天只干一件事」真的会发生。没有配方的时候，
 * 30 天里每天都是四五件事平铺——那是排班表，不是生活。
 *
 * 冲突顺序照 activity-pool.md 的最后那张表：旅行 > 生病 > 通宵 > 大扫除 > 摆烂。
 * 旅行还没做（要跨天状态），其余四条在这里。
 */
import { makeRng } from './seed';

export type RecipeId = 'lazy' | 'sick' | 'deepclean' | 'marathon' | 'trip' | 'homecoming' | 'festival';

export interface Recipe {
  id: RecipeId;
  label: string;
  /** 这一天最多几段活动 */
  budget: number;
  /** 起床时间（分钟） */
  wakeAt: number;
  /** 只允许这些大类（空 = 不限制） */
  kinds?: string[];
  /** 只在晚上开始 */
  eveningOnly?: boolean;
  /** 当天的健康度（不填 = 沿用康复曲线） */
  health?: number;
}

export const RECIPES: Record<string, Recipe> = {
  lazy: {
    id: 'lazy',
    label: '彻底摆烂日',
    budget: 3,
    wakeAt: 11 * 60,
    kinds: ['idle', 'meal', 'social'],
  },
  sick: {
    id: 'sick',
    label: '生病日',
    budget: 2,
    wakeAt: 10 * 60 + 30,
    kinds: ['idle', 'meal'],
    health: 42,
  },
  deepclean: {
    id: 'deepclean',
    label: '大扫除日',
    budget: 3,
    wakeAt: 9 * 60,
    kinds: ['chores', 'meal', 'idle'],
  },
  marathon: {
    id: 'marathon',
    label: '通宵追番日',
    budget: 2,
    wakeAt: 10 * 60,
    kinds: ['anime', 'idle', 'meal'],
    eveningOnly: true,
  },
  trip: {
    id: 'trip',
    label: '旅行',
    budget: 3,
    wakeAt: 8 * 60,
    kinds: ['outing', 'short_trip', 'meal', 'idle'],
  },
  homecoming: {
    id: 'homecoming',
    label: '回家日',
    budget: 2,
    wakeAt: 10 * 60,
    kinds: ['idle', 'meal'],
  },
};

export interface RecipeHistory {
  /** 最近一次生病日距今多少天（没生过就是 null） */
  daysSinceSick: number | null;
  daysSinceDeepclean: number | null;
  daysSinceMarathon: number | null;
}

export interface RecipeChoice {
  recipe: Recipe | null;
  reason: string;
}

/**
 * 今天是不是特殊日。
 *
 * 全部用种子掷骰——同一天重算结果必须一样，不然早上生成一次、晚上再查一次会变。
 */
export function pickRecipe(dateKey: string, history: RecipeHistory): RecipeChoice {
  const rng = makeRng(`recipe|${dateKey}`);

  // 生病：2%/天，30 天冷却。生病日只能在家，所以在外面的日子不抽（P3 先不管旅行）
  if ((history.daysSinceSick === null || history.daysSinceSick >= 30) && rng.chance(0.02)) {
    return { recipe: RECIPES.sick, reason: '2% 掷中，且 30 天内没生过病' };
  }
  // 通宵追番：约每月一次
  if ((history.daysSinceMarathon === null || history.daysSinceMarathon >= 25) && rng.chance(0.05)) {
    return { recipe: RECIPES.marathon, reason: '每月一次的通宵，25 天冷却' };
  }
  // 大扫除日：约每月一次
  if ((history.daysSinceDeepclean === null || history.daysSinceDeepclean >= 25) && rng.chance(0.04)) {
    return { recipe: RECIPES.deepclean, reason: '月度大扫除，25 天冷却' };
  }
  // 摆烂日：3%/天，随时可能
  if (rng.chance(0.03)) {
    return { recipe: RECIPES.lazy, reason: '3% 掷中，今天不想动' };
  }
  return { recipe: null, reason: '普通的一天' };
}

/**
 * 健康度康复曲线（§9.2）。
 *
 * 生病当天直接掉到 42，之后每天往回爬：+8 / +14 / +18 / +12 / +6，
 * 六天到 100。不是第二天就好——那样「生病」就只是一句台词。
 */
export const RECOVERY_STEPS = [8, 14, 18, 12, 6];

export function healthForDay(input: {
  yesterdayHealth: number;
  sickToday: boolean;
  /** 昨天是不是生病当天（用来取第几步康复） */
  daysSinceSick: number | null;
}): number {
  if (input.sickToday) return 42;
  const prev = input.yesterdayHealth;
  if (prev >= 100) return 100;
  if (prev <= 0) return 42;
  const stepIndex = Math.min(
    RECOVERY_STEPS.length - 1,
    Math.max(0, (input.daysSinceSick ?? 1) - 1),
  );
  return Math.min(100, prev + RECOVERY_STEPS[stepIndex]);
}

/** 健康度影响日程（§9.2）：低于 60 只能在家、只能做低强度的事。 */
export function healthRestricts(health: number): boolean {
  return health < 60;
}
