/**
 * 好感度 / 亲密度的渐进增长模型（纯函数）。
 *
 * 设计目标：日积月累，不能快速涨满。
 *
 * 核心机制：
 * 1. **递减增长**：数值越高，每天能涨的越少（边际递减）
 *    - 0-200 段：最多 +5/天（容易建立关系）
 *    - 200-400 段：最多 +3/天
 *    - 400-600 段：最多 +2/天
 *    - 600-800 段：最多 +1/天
 *    - 800+ 段：最多 +0.5/天（已经很亲密，很难再涨）
 *
 * 2. **不对称**：下降比上升更容易（坏事影响更大，符合真实关系）
 *    - 上升受递减约束
 *    - 下降按固定额度（−5/天），不递减
 *
 * 3. **连续性要求**：只有持续互动才涨
 *    - 中断联系 > 7 天：开始缓慢衰减
 */

export const RELATION_MAX = 1000;

/** 分段增长上限（每天最多涨多少）。整数分段，避免小数在四舍五入时丢失。 */
const GROWTH_TIERS: Array<{ below: number; maxGain: number }> = [
  { below: 200, maxGain: 5 },
  { below: 400, maxGain: 3 },
  { below: 600, maxGain: 2 },
  { below: 800, maxGain: 1 },
  { below: 1000, maxGain: 1 },
];

/** 每日最大降幅（不递减，坏事影响直接）。 */
export const MAX_DAILY_LOSS = 5;

/** 长期不联系的衰减：超过 N 天开始每天掉多少。 */
export const INACTIVITY_THRESHOLD_DAYS = 7;
export const INACTIVITY_DECAY_PER_DAY = 0.5;

/** 取当前数值允许的单日最大增长。 */
export function maxGainAt(current: number): number {
  for (const tier of GROWTH_TIERS) {
    if (current < tier.below) return tier.maxGain;
  }
  return 1;
}

export interface RelationChange {
  /** 变化后的值 */
  next: number;
  /** 实际应用的变化量 */
  applied: number;
  /** 是否被限制 */
  capped: boolean;
  /** 说明 */
  note?: string;
}

/**
 * 应用关系值变化（好感度/亲密度通用）。
 *
 * @param current 当前值（0-1000）
 * @param proposed AI 提议的新值
 * @param opts 可选：连续互动天数、距上次互动天数
 */
export function applyGradualChange(
  current: number,
  proposed: number,
  opts: { streakDays?: number; daysSinceInteraction?: number } = {},
): RelationChange {
  const cur = Math.round(current);
  const prop = Math.round(proposed);

  if (prop === cur) return { next: cur, applied: 0, capped: false };

  const isRising = prop > cur;

  if (isRising) {
    // 上升：受递减上限约束
    let limit = maxGainAt(cur);

    // 额外加成：连续互动天数越多，可以稍微多涨（但不超过基础上限的 1.5 倍）
    if (opts.streakDays && opts.streakDays >= 7) {
      limit = Math.min(limit * 1.5, limit + 1);
    }
    // 中断联系则不给加成，甚至打折
    if (opts.daysSinceInteraction && opts.daysSinceInteraction > 3) {
      limit = limit * 0.5;
    }

    const desired = prop - cur;
    const applied = Math.min(desired, limit);
    const next = clampInt(cur + applied, 0, RELATION_MAX);
    return {
      next,
      applied: next - cur,
      capped: applied < desired,
      note: applied < desired ? `增长受边际递减限制（上限 ${limit.toFixed(1)}/天）` : undefined,
    };
  }

  // 下降：固定额度，不递减（坏事影响直接）
  const desired = cur - prop;
  const applied = Math.min(desired, MAX_DAILY_LOSS);
  const next = clampInt(cur - applied, 0, RELATION_MAX);
  return {
    next,
    applied: next - cur,
    capped: applied < desired,
    note: applied < desired ? `下降受单日上限限制（${MAX_DAILY_LOSS}/天）` : undefined,
  };
}

/**
 * 长期不联系的衰减。
 * 超过 INACTIVITY_THRESHOLD_DAYS 天后，每天缓慢下降。
 */
export function applyInactivityDecay(current: number, daysSinceInteraction: number): RelationChange {
  if (daysSinceInteraction <= INACTIVITY_THRESHOLD_DAYS) {
    return { next: Math.round(current), applied: 0, capped: false };
  }
  const inactiveDays = daysSinceInteraction - INACTIVITY_THRESHOLD_DAYS;
  const decay = Math.min(inactiveDays * INACTIVITY_DECAY_PER_DAY, 15); // 单次最多掉 15
  const next = clampInt(Math.round(current - decay), 0, RELATION_MAX);
  return {
    next,
    applied: next - Math.round(current),
    capped: false,
    note: `已 ${daysSinceInteraction} 天没联系，关系缓慢淡化`,
  };
}

/**
 * 估算从当前值涨到目标值需要多少天（用于展示"还需要多久"）。
 */
export function estimateDaysToReach(from: number, to: number): number {
  if (to <= from) return 0;
  let cur = from;
  let days = 0;
  while (cur < to && days < 5000) {
    const gain = maxGainAt(cur);
    cur = Math.min(cur + gain, to);
    days += 1;
  }
  return days;
}

function clampInt(n: number, min: number, max: number): number {
  return Math.min(Math.max(Math.round(n), min), max);
}
