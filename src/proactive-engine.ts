/**
 * 主动消息决策引擎（纯函数，可单测）。
 *
 * 目标：不是"到点就发"，而是判断"现在值不值得说话"。
 * 输入是各种信号，输出是分数 + 理由 + 是否发送。
 *
 * 打分维度：
 *   + 事由强度（有具体话题可跟进，权重最高）
 *   + 互动缺口（很久没聊了）
 *   + 时间合适度（在用户历史活跃时段）
 *   + 环境变化（天气突变、特殊日期）
 *   - 静默惩罚（用户刚聊完）
 *   - 冷却惩罚（刚发过主动消息）
 *   - 未回惩罚（上次主动消息用户没回）
 */

import { moodScoreAdjust, type MoodResult } from './mood';

/** 用户行为画像（从 D1 统计得出）。 */
export interface UserProfile {
  /** 最近 14 天每天各小时的发消息次数（index 0-23） */
  hourlyActivity: number[];
  /** 最近 14 天总消息数 */
  totalMessages: number;
  /** 距离用户上次发消息的分钟数（null = 从未发过） */
  minutesSinceLastUserMsg: number | null;
  /** 距离上次主动消息的分钟数（null = 从未发过） */
  minutesSinceLastProactive: number | null;
  /** 上次主动消息之后用户回复了几条（0 = 未回复） */
  repliesAfterLastProactive: number;
}

/** 环境信号。 */
export interface EnvironmentSignal {
  /** 当前小时（0-23，北京时间） */
  hour: number;
  /** 是否是节假日/周末 */
  isRestDay: boolean;
  /** 天气突变（如降温 > 6 度、雨转晴等） */
  weatherChanged: boolean;
  /** 特殊日期（纪念日、节日当天等） */
  isSpecialDay: boolean;
}

/** 待跟进事项（从 memory.md「进行中的事项」提取）。 */
export interface PendingTopic {
  content: string;
  /** 距今多少天 */
  daysAgo: number;
}

export interface DecisionInput {
  profile: UserProfile;
  env: EnvironmentSignal;
  pendingTopics: PendingTopic[];
  /** 主动强度：quiet=少说 / normal=正常 / active=活跃 */
  level: 'quiet' | 'normal' | 'active';
  /** 用户情绪（可选，来自 mood 模块） */
  mood?: MoodResult | null;
  /** 里程碑（可选，来自 milestone 模块） */
  milestones?: Array<{ topic: string; weight: number }>;
  /** 历史反馈调整系数（来自 feedback 模块，>1 表示应降低频率） */
  feedbackMultiplier?: number;
  /** 触发来源：早晚固定问候 / 白天随机；固定时段的「时间本身」就是事由 */
  slot?: 'morning' | 'evening' | 'random';
}

export interface Decision {
  shouldSend: boolean;
  score: number;
  /** 触发的理由（用于日志和提示词） */
  reasons: string[];
  /** 本次可用的事由（供生成时参考） */
  topics: string[];
}

/** 各强度档的阈值与倍数。 */
const LEVEL_CONFIG = {
  quiet: { threshold: 70, cooldownMultiplier: 2 },
  normal: { threshold: 50, cooldownMultiplier: 1 },
  active: { threshold: 35, cooldownMultiplier: 0.6 },
} as const;

/** 静默期：用户最近 N 分钟内有互动就不发。 */
export const SILENCE_MINUTES = 30;
/** 基础冷却：距上次主动消息至少 N 分钟。 */
export const BASE_COOLDOWN_MINUTES = 180;
/** 未回复时冷却翻倍的上限倍数。 */
export const UNANSWERED_COOLDOWN_MULTIPLIER = 3;

/**
 * 计算用户活跃时段权重（0~1）。
 * 用最近 14 天该小时的发消息占比衡量。
 */
export function hourActivityWeight(hourlyActivity: number[], hour: number): number {
  const total = hourlyActivity.reduce((s, n) => s + n, 0);
  if (total === 0) return 0.3; // 无数据时给中性偏低权重
  const max = Math.max(...hourlyActivity, 1);
  return Math.min(1, hourlyActivity[hour] / max);
}

/** 主决策函数。 */
export function decideProactive(input: DecisionInput): Decision {
  const { profile, env, pendingTopics, level, mood, milestones, feedbackMultiplier, slot } = input;
  const fixedSlot = slot === 'morning' || slot === 'evening';
  const cfg = LEVEL_CONFIG[level];
  const reasons: string[] = [];
  const topics: string[] = [];
  let score = 0;

  // ---------- 硬性否决 ----------
  // 1) 用户刚聊过（静默期）
  if (profile.minutesSinceLastUserMsg !== null && profile.minutesSinceLastUserMsg < SILENCE_MINUTES) {
    return { shouldSend: false, score: 0, reasons: [`用户 ${profile.minutesSinceLastUserMsg} 分钟前刚聊过`], topics: [] };
  }

  // 2) 冷却期未到（受历史反馈系数影响）
  if (profile.minutesSinceLastProactive !== null) {
    const unanswered = profile.repliesAfterLastProactive === 0;
    const fb = feedbackMultiplier && feedbackMultiplier > 0 ? feedbackMultiplier : 1;
    const cooldown =
      BASE_COOLDOWN_MINUTES *
      cfg.cooldownMultiplier *
      (unanswered ? UNANSWERED_COOLDOWN_MULTIPLIER : 1) *
      fb;
    if (profile.minutesSinceLastProactive < cooldown) {
      return {
        shouldSend: false,
        score: 0,
        reasons: [
          `距上次主动消息 ${Math.round(profile.minutesSinceLastProactive)} 分钟，冷却需 ${Math.round(cooldown)} 分钟${unanswered ? '（上次未回复）' : ''}`,
        ],
        topics: [],
      };
    }
  }

  // ---------- 加分项 ----------
  // 0) 固定时段：用户约好的早安/睡前问候，时间本身就是事由
  //    （以前只有随机消息，固定时段也要凑够 50 分，等于永远不发）
  //    分值取 55：高于 normal 阈值（50），保证「约好的问候」不会被活跃度之类的
  //    细项卡死；仍然受静默期/冷却/情绪否决约束，一天最多早晚各一条。
  if (fixedSlot) {
    score += 55;
    reasons.push(slot === 'morning' ? '到了早安问候时间' : '到了睡前问候时间');
  }

  // 1) 情绪信号（可能加分或否决）
  if (mood) {
    const adj = moodScoreAdjust(mood);
    if (adj.delta < 0) {
      return { shouldSend: false, score: 0, reasons: [adj.reason ?? '情绪不适合打扰'], topics: [] };
    }
    if (adj.delta > 0) {
      score += adj.delta;
      if (adj.reason) reasons.push(adj.reason);
    }
  }

  // 1) 里程碑（权重高，因为是不可复现的时刻）
  if (milestones && milestones.length > 0) {
    for (const m of milestones) {
      score += m.weight;
      reasons.push(m.topic);
      topics.push(m.topic);
    }
  }

  // 2) 事由强度（权重最高）
  if (pendingTopics.length > 0) {
    const fresh = pendingTopics.filter((t) => t.daysAgo <= 3);
    if (fresh.length > 0) {
      score += 40;
      reasons.push(`有 ${fresh.length} 个近期待跟进事项`);
      topics.push(...fresh.slice(0, 2).map((t) => t.content));
    } else {
      score += 20;
      reasons.push(`有 ${pendingTopics.length} 个待跟进事项`);
      topics.push(...pendingTopics.slice(0, 1).map((t) => t.content));
    }
  }

  // 2) 环境变化
  if (env.weatherChanged) {
    score += 25;
    reasons.push('天气有明显变化');
    topics.push('天气变化（可提醒加衣/带伞）');
  }
  if (env.isSpecialDay) {
    score += 25;
    reasons.push('今天是特殊日期');
    topics.push('特殊日期');
  }

  // 3) 互动缺口
  if (profile.minutesSinceLastUserMsg !== null) {
    const hours = profile.minutesSinceLastUserMsg / 60;
    if (hours >= 24) {
      score += 20;
      reasons.push('超过 24 小时没聊');
    } else if (hours >= 8) {
      score += 12;
      reasons.push('半天没聊');
    } else if (hours >= 3) {
      score += 5;
    }
  } else {
    score += 15;
    reasons.push('还没有任何聊天记录');
  }

  // 4) 时间合适度
  const activityWeight = hourActivityWeight(profile.hourlyActivity, env.hour);
  score += Math.round(activityWeight * 20);
  if (activityWeight >= 0.5) reasons.push('处于用户常活跃时段');

  // 休息日白天略降权（可能在补觉/外出）
  if (env.isRestDay && env.hour < 10) {
    score -= 10;
    reasons.push('休息日早晨，降低打扰概率');
  }

  // 深夜强降权（睡前的固定问候窗口除外：22:45-23:15 本来就是它该发的时间）
  const isEveningSlot = slot === 'evening' && (env.hour === 22 || env.hour === 23);
  if ((env.hour >= 23 || env.hour < 7) && !isEveningSlot) {
    score -= 40;
    reasons.push('深夜时段');
  }

  // 5) 未回复惩罚（累积）
  if (profile.repliesAfterLastProactive === 0 && profile.minutesSinceLastProactive !== null) {
    score -= 15;
    reasons.push('上次主动消息未得到回复');
  }

  const shouldSend = score >= cfg.threshold;
  return { shouldSend, score, reasons, topics };
}

/** 从 memory.md 的「进行中的事项」提取待跟进话题（纯函数）。 */
export function extractPendingTopics(memory: string, today: Date): PendingTopic[] {
  // 按 ## 标题切块，找到"进行中的事项"这一块（到下一个 ## 为止）
  const lines = memory.split('\n');
  const startIdx = lines.findIndex((l) => /^##\s+进行中的事项\s*$/.test(l.trim()));
  if (startIdx === -1) return [];

  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) {
      endIdx = i;
      break;
    }
  }

  const out: PendingTopic[] = [];
  for (const line of lines.slice(startIdx + 1, endIdx)) {
    const m = line.match(/^-\s*\[(\d{4})-(\d{2})-(\d{2})\]\s*(.+)$/);
    if (!m) continue;
    const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    const daysAgo = Math.floor((today.getTime() - date.getTime()) / 86400000);
    if (daysAgo >= 0 && daysAgo <= 14) {
      out.push({ content: m[4].trim(), daysAgo });
    }
  }
  return out.sort((a, b) => a.daysAgo - b.daysAgo);
}
