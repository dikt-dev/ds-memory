/**
 * 好感度与亲密度的独立驱动（纯函数）。
 *
 * 设计核心：两者由**不同的信号**驱动，可以背离。
 *
 * - 亲密度 intimacy ← 互动「量」：聊了多久、多少轮、多少天
 *   只增不减（除非长期失联）；吵架也照样涨，因为确实陪伴了。
 *   受「有效聊天天数」硬上限约束，无法靠猛聊刷满。
 *
 * - 好感度 affinity ← 互动「质」：开心吗、被关心吗、被冒犯吗
 *   可升可降，与聊天时长无关；话说过头会掉，但单日降幅有上限。
 *
 * 这样矩阵 25 格才能真实用到：
 *   认识很久但闹别扭 → 好感低 + 亲密高 = 「别扭的亲近」
 *   刚认识但一见如故 → 好感高 + 亲密低 = 「热辣亲近」
 */

export const RELATION_MAX = 1000;

// ────────────────────────────────────────────────────────────
// 亲密度：由「互动量」驱动
// ────────────────────────────────────────────────────────────

/** 亲密度初始值（新关系）。 */
export const INTIMACY_BASE = 300;
/** 每累计 1 个「有效聊天日」解锁的亲密度上限。 */
export const INTIMACY_PER_DAY = 2;
/** 单日亲密度最大涨幅（防止一天猛聊暴涨）。 */
export const INTIMACY_MAX_DAILY_GAIN = 4;
/** 长期失联后每天下降。 */
export const INTIMACY_DECAY_PER_DAY = 0.5;
/** 开始衰减的失联天数。 */
export const INTIMACY_DECAY_AFTER_DAYS = 7;

export interface IntimacySignals {
  /** 当天用户消息条数（轮次） */
  userMessages: number;
  /** 当天是否连续聊天（与前一天衔接） */
  streakDays: number;
  /** 当天新增的记忆条目数（共同经历） */
  newMemoryEntries: number;
  /** 累计有效聊天天数（决定硬上限） */
  activeDays: number;
  /** 距上次互动的天数 */
  daysSinceInteraction: number;
}

/**
 * 亲密度硬上限：只与「累计有效聊天天数」有关，与聊了多少轮无关。
 * 例：第 0 天上限 300，第 100 天上限 500，第 350 天上限 1000。
 *
 * 额外宽恕：若当前值已超过天数上限（说明历史数据更丰富），
 * 允许在天数上限之上再缓慢增长，避免“卡死”。
 */
export function maxIntimacyForDays(activeDays: number): number {
  const d = Math.max(0, Math.floor(activeDays));
  return Math.min(RELATION_MAX, INTIMACY_BASE + d * INTIMACY_PER_DAY);
}

/**
 * 计算当天亲密度增量（只看量，不看情绪质量）。
 * 返回未经上限截断的原始增量。
 */
export function computeIntimacyGain(sig: IntimacySignals): number {
  // ★ 保底：当天真的聊过，至少 +1。
  //   之前只按「每 10 轮 +1」计，导致「每天 8 轮」这种常见强度算出来是 0，
  //   聊满一年亲密度愣是没变——这显然不是「日积月累」该有的样子。
  if (sig.userMessages <= 0) return 0;

  let gain = 1;

  // ① 聊天轮次：每 10 轮额外 +1，最多 +2（叠加保底后总上限仍是 +3）
  gain += Math.min(2, Math.floor(sig.userMessages / 10));

  // ② 连续聊天 ≥7 天：额外 +1（习惯性陪伴）
  if (sig.streakDays >= 7) gain += 1;

  // ③ 共同经历：每新增 5 条记忆 +1，上限 +2
  gain += Math.min(2, Math.floor(sig.newMemoryEntries / 5));

  // ④ 单日总涨幅上限
  return Math.min(gain, INTIMACY_MAX_DAILY_GAIN);
}

/** 长期失联衰减。 */
export function intimacyDecay(daysSinceInteraction: number): number {
  if (daysSinceInteraction <= INTIMACY_DECAY_AFTER_DAYS) return 0;
  const inactive = daysSinceInteraction - INTIMACY_DECAY_AFTER_DAYS;
  return Math.min(inactive * INTIMACY_DECAY_PER_DAY, 15); // 单次最多 -15
}

/**
 * 应用亲密度变化：先加增量，再按硬上限截断。
 *
 * ★ **不在这里做失联衰减**：衰减统一由 applyRelationDecay 负责（脱敏时只吃一次）。
 *   历史上两处都会扣，导致同一天归档里亲密度被扣两次。
 *
 * 硬上限规则：
 * - 未达上限 → 正常增长
 * - 已超上限 → 仍允许每天 +1 的「宽恕增长」（不卡死，但明显变慢）
 */
export function applyIntimacyChange(
  current: number,
  sig: IntimacySignals,
): { next: number; applied: number; cappedByDays: boolean } {
  const cur = Math.round(current);
  const gain = computeIntimacyGain(sig);
  const ceiling = maxIntimacyForDays(sig.activeDays);

  let next = cur;
  let cappedByDays = false;

  if (cur >= ceiling) {
    // 已达天数天花板：只给「宽恕增长」（最多 +1，且要求当天确实聊了）
    cappedByDays = true;
    if (sig.userMessages > 0) next = cur + Math.min(1, gain);
  } else {
    next = cur + gain;
    if (next > ceiling) {
      next = ceiling;
      cappedByDays = true;
    }
  }

  next = Math.min(Math.max(Math.round(next), 0), RELATION_MAX);
  return { next, applied: next - cur, cappedByDays };
}

// ────────────────────────────────────────────────────────────
// 好感度：由「互动质量」驱动
// ────────────────────────────────────────────────────────────

/** 单日最大涨幅（防刷）。 */
export const AFFINITY_MAX_DAILY_GAIN = 5;
/** 单日最大降幅（B1：有上限，但多天可一直降）。 */
export const AFFINITY_MAX_DAILY_LOSS = 5;

/** 好感度的质量信号（来自当天对话分析）。 */
export interface AffinitySignals {
  /** 开心/温暖的对话轮数 */
  warmTurns: number;
  /** 用户表达感谢/关心的次数 */
  gratefulCount: number;
  /** 冒犯/不耐烦的次数 */
  offensiveCount: number;
  /** 用户情绪低落的天数占比加权（低落但被陪伴 → 微升） */
  lowMoodButCompanioned: boolean;
  /** 是否发生了明确的冲突事件 */
  hadConflict: boolean;
  /** 用户整天完全不回应（冷落） */
  ignoredAllDay: boolean;
}

/**
 * 计算好感度变化量（可正可负）。
 * 与聊天时长无关：只看了「感受好不好」。
 */
export function computeAffinityDelta(sig: AffinitySignals): { delta: number; reasons: string[] } {
  let delta = 0;
  const reasons: string[] = [];

  // ① 温暖对话
  if (sig.warmTurns > 0) {
    const gain = Math.min(3, Math.ceil(sig.warmTurns / 3));
    delta += gain;
    reasons.push(`温暖对话 ${sig.warmTurns} 次 +${gain}`);
  }

  // ② 感谢/关心
  if (sig.gratefulCount > 0) {
    const gain = Math.min(3, sig.gratefulCount);
    delta += gain;
    reasons.push(`表达感谢/关心 ${sig.gratefulCount} 次 +${gain}`);
  }

  // ③ 用户低落但被陪伴（陪伴有价值）
  if (sig.lowMoodButCompanioned) {
    delta += 1;
    reasons.push('陪伴低落情绪 +1');
  }

  // ④ 冒犯/不耐烦：每次 -5，无上限（但下面会被单日上限截断）
  if (sig.offensiveCount > 0) {
    const loss = sig.offensiveCount * 5;
    delta -= loss;
    reasons.push(`冒犯/不耐烦 ${sig.offensiveCount} 次 -${loss}`);
  }

  // ⑤ 明确冲突事件：严重扣分
  if (sig.hadConflict) {
    delta -= 10;
    reasons.push('发生明确冲突 -10');
  }

  // ⑥ 整天冷落：轻微扣分
  if (sig.ignoredAllDay) {
    delta -= 2;
    reasons.push('整天未回应 -2');
  }

  return { delta, reasons };
}

/**
 * 应用好感度变化（B1：单日升降都有上限，但多天可累积到底）。
 */
export function applyAffinityChange(
  current: number,
  sig: AffinitySignals,
): { next: number; applied: number; reasons: string[] } {
  const cur = Math.round(current);
  const { delta, reasons } = computeAffinityDelta(sig);
  const capped = Math.min(
    Math.max(delta, -AFFINITY_MAX_DAILY_LOSS),
    AFFINITY_MAX_DAILY_GAIN,
  );
  const next = Math.min(Math.max(Math.round(cur + capped), 0), RELATION_MAX);
  return { next, applied: next - cur, reasons };
}

// ────────────────────────────────────────────────────────────
// 质量信号提取（关键词，零成本）
// ────────────────────────────────────────────────────────────

const GRATEFUL_WORDS = ['谢谢', '感谢', '辛苦', '麻烦你', '多谢', '谢啦', '爱你', '想你', '还好吗'];
const OFFENSIVE_WORDS = ['滚', '烦死', '别废话', '没用', '垃圾', '闭嘴', '傻', '蠢'];
const CONFLICT_WORDS = ['吵架', '生气', '失望', '不想理', '讨厌你', '分手'];

export interface QualityScan {
  gratefulCount: number;
  offensiveCount: number;
  hadConflict: boolean;
  warmTurns: number;
  hits: string[];
}

/**
 * 从当天用户消息文本中提取质量信号。
 * @param userTexts 当天所有用户消息
 */
export function scanQuality(userTexts: string[]): QualityScan {
  let gratefulCount = 0;
  let offensiveCount = 0;
  let warmTurns = 0;
  let hadConflict = false;
  const hits: string[] = [];

  for (const text of userTexts) {
    if (!text) continue;
    let warm = false;

    for (const w of GRATEFUL_WORDS) {
      if (text.includes(w)) {
        gratefulCount += 1;
        hits.push(w);
        warm = true;
        break; // 一条消息只算一次感谢
      }
    }

    for (const w of OFFENSIVE_WORDS) {
      if (text.includes(w)) {
        offensiveCount += 1;
        hits.push(w);
        break;
      }
    }

    for (const w of CONFLICT_WORDS) {
      if (text.includes(w)) {
        hadConflict = true;
        hits.push(w);
        break;
      }
    }

    // 温暖：正面语气词
    if (text.includes('哈哈') || text.includes('开心') || text.includes('喜欢') || text.includes('太好了')) {
      warm = true;
    }
    if (warm) warmTurns += 1;
  }

  return { gratefulCount, offensiveCount, hadConflict, warmTurns, hits };
}
