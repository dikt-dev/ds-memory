/**
 * 心情值的环境与时间影响（纯函数）。
 *
 * 心情值（0-1000）除了受对话内容影响，还会被客观环境左右：
 * - 时间：深夜/凌晨天然更低，午后较高
 * - 天气：阴雨/雾霾降低，晴朗提升
 * - 节假日：休息日心情基线更高（但清晨会低）
 * - 季节：冬季偏低，春夏偏高
 *
 * 这些是"被动漂移"，每次聊天/定时任务时计算，逐步影响 memory.md 中的心情值。
 */
import type { WeatherInfo } from './prompt';

export interface MoodEnvironment {
  /** 北京时间小时（0-23） */
  hour: number;
  /** 是否节假日/周末 */
  isRestDay: boolean;
  /** 天气信息（可能为 null） */
  weather: WeatherInfo | null;
  /** 月份（1-12） */
  month: number;
}

export interface MoodDrift {
  /** 环境带来的偏移量（可为负） */
  delta: number;
  /** 影响理由（用于日志） */
  reasons: string[];
}

/** 时间段对心情的影响（每小时的基础偏移）。 */
export function timeOfDayDelta(hour: number): { delta: number; reason?: string } {
  if (hour >= 0 && hour < 5) return { delta: -25, reason: '凌晨时段，精神低落' };
  if (hour >= 5 && hour < 8) return { delta: -10, reason: '清晨刚醒，状态偏低' };
  if (hour >= 8 && hour < 11) return { delta: +8, reason: '上午精神好' };
  if (hour >= 11 && hour < 14) return { delta: +12, reason: '午间状态最佳' };
  if (hour >= 14 && hour < 18) return { delta: +5, reason: '下午平稳' };
  if (hour >= 18 && hour < 22) return { delta: 0, reason: undefined };
  return { delta: -12, reason: '深夜，疲惫' };
}

/** 天气对心情的影响。 */
export function weatherDelta(weather: WeatherInfo | null): { delta: number; reason?: string } {
  if (!weather) return { delta: 0 };
  const desc = weather.desc;

  if (/雷|暴雨|大暴雨/.test(desc)) return { delta: -20, reason: `恶劣天气（${desc}）` };
  if (/雨|雪/.test(desc)) return { delta: -12, reason: `雨雪天气（${desc}）` };
  if (/雾|霾|沙|尘/.test(desc)) return { delta: -15, reason: `雾霾/沙尘（${desc}）` };
  if (/阴/.test(desc)) return { delta: -5, reason: '阴天' };
  if (/多云/.test(desc)) return { delta: 0 };
  if (/晴|大致晴朗/.test(desc)) return { delta: +10, reason: `天气晴朗（${desc}）` };

  // 温度极值影响
  if (weather.temp_c >= 35) return { delta: -10, reason: `酷热（${weather.temp_c}°C）` };
  if (weather.temp_c <= 0) return { delta: -8, reason: `严寒（${weather.temp_c}°C）` };

  return { delta: 0 };
}

/** 季节对心情的影响（基线微调）。 */
export function seasonDelta(month: number): { delta: number; reason?: string } {
  if (month >= 3 && month <= 5) return { delta: +8, reason: '春天，心情舒展' };
  if (month >= 6 && month <= 8) return { delta: +5, reason: '夏天，活力充沛' };
  if (month >= 9 && month <= 10) return { delta: +6, reason: '秋高气爽' };
  return { delta: -6, reason: '冬季，容易低落' };
}

/** 休息日对心情的影响（需结合时段）。 */
export function restDayDelta(hour: number): { delta: number; reason?: string } {
  if (hour < 10) return { delta: -8, reason: '休息日清晨（可能被打扰睡眠）' };
  return { delta: +12, reason: '休息日，心情放松' };
}

/**
 * 计算环境对心情的总影响。
 * 注意：这是"漂移方向"，实际应用时会与对话提炼的结果叠加，且受单日上限约束。
 */
export function computeMoodDrift(env: MoodEnvironment): MoodDrift {
  const reasons: string[] = [];
  let delta = 0;

  const time = timeOfDayDelta(env.hour);
  delta += time.delta;
  if (time.reason) reasons.push(time.reason);

  const weather = weatherDelta(env.weather);
  delta += weather.delta;
  if (weather.reason) reasons.push(weather.reason);

  const season = seasonDelta(env.month);
  delta += season.delta;
  if (season.reason) reasons.push(season.reason);

  if (env.isRestDay) {
    const rest = restDayDelta(env.hour);
    delta += rest.delta;
    if (rest.reason) reasons.push(rest.reason);
  }

  return { delta, reasons };
}
