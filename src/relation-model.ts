/**
 * 关系 / 情绪的数值常量单一来源。
 *
 * 背景（2026-10-31 结构审查 P0-2）：`RELATION_MAX` 曾在 memory-maintenance、relation-drivers、
 * relation-growth 三个文件各写一份，`MOOD_MAX_DAILY_DELTA` 在 attitude 与 memory-maintenance 各一份。
 * 同一个上限改一处漏两处，线上就会出现「结算用 1000、增量判断用 800」这种很难查的偏差。
 *
 * 约定：**这里只放数值和极小的纯换算**，不放业务规则；规则留在各自的模块里。
 */

/** 5 轴关系与累计聊天天数的上限（满值）。 */
export const RELATION_MAX = 1000;

/** 5 轴关系下限。 */
export const RELATION_MIN = 0;

/** 心情值单日最大变化幅度（每日结算用）。 */
export const MOOD_MAX_DAILY_DELTA = 80;

/** 亲密度硬上限的基数：`INTIMACY_BASE + 有效天数 × INTIMACY_PER_DAY`（封顶 RELATION_MAX）。 */
export const INTIMACY_BASE = 300;

/** 每个有效聊天日允许的亲密度上限增量。 */
export const INTIMACY_PER_DAY = 2;
