/**
 * 生活系统的类型。
 *
 * 对应 docs/design/ai-life-system.md §5.2（池子）、§5.4（弧线）。
 * 只放类型和常量；逻辑在 pool / planner / validate。
 */

/** 活动大类。和 activity-pool.md 的十个小节一一对应。 */
export type ActKind =
  | 'anime'
  | 'game'
  | 'hobby'
  | 'chores'
  | 'meal'
  | 'outing'
  | 'short_trip'
  | 'idle'
  | 'weather'
  | 'social';

/** 天气/状态的标签。tagsOk 用它筛候选。 */
export type ActTag =
  | 'indoor'
  | 'outdoor'
  | 'rainy_ok'
  | 'sunny_only'
  | 'hot_ok'
  | 'cold_ok'
  | 'alone'
  | 'tired_ok'
  | 'noisy';

/** 连续型单元挂到哪种弧线上。 */
export type ArcKind = 'series' | 'game' | 'trip';

export interface ActUnit {
  id: string;
  kind: ActKind;
  name: string;
  min: number;
  max: number;
  tags: ActTag[];
  /** 结束后的心情增量，-1 ~ 1 */
  mood: number;
  interruptible: boolean;
  /** 正在做这件事时她回消息的概率 */
  replyChance: number;
  /** 连续型：接昨天进度 */
  arc?: ArcKind;
  /** 给生成器的填充提示 */
  fill: string;
  weight: number;
}

/** 一天里的一段（空档或已填的活动）。分钟数以当天 0 点为原点。 */
export interface Slot {
  start: number;
  end: number;
  unitId?: string;
}

/** 天气/环境输入。 */
export interface DayEnv {
  /** 'rain' | 'snow' | 'sunny' | 'cloudy' */
  weather: string;
  /** 最高温，℃ */
  tempC: number;
  /** 是否在家（旅行期间为 false） */
  atHome: boolean;
}
