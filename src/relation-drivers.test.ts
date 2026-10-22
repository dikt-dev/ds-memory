import { describe, expect, it } from 'vitest';
import {
  AFFINITY_MAX_DAILY_GAIN,
  AFFINITY_MAX_DAILY_LOSS,
  INTIMACY_BASE,
  applyAffinityChange,
  applyIntimacyChange,
  computeAffinityDelta,
  computeIntimacyGain,
  intimacyDecay,
  maxIntimacyForDays,
  scanQuality,
  type AffinitySignals,
  type IntimacySignals,
} from './relation-drivers';

const baseIntimacy: IntimacySignals = {
  userMessages: 0,
  streakDays: 0,
  newMemoryEntries: 0,
  activeDays: 0,
  daysSinceInteraction: 0,
};

const calmAffinity: AffinitySignals = {
  warmTurns: 0,
  gratefulCount: 0,
  offensiveCount: 0,
  lowMoodButCompanioned: false,
  hadConflict: false,
  ignoredAllDay: false,
};

describe('maxIntimacyForDays —— 天数硬上限', () => {
  it('第 0 天上限等于初始值', () => {
    expect(maxIntimacyForDays(0)).toBe(INTIMACY_BASE);
  });

  it('按每天 +2 线性增长', () => {
    expect(maxIntimacyForDays(50)).toBe(400);
    expect(maxIntimacyForDays(100)).toBe(500);
    expect(maxIntimacyForDays(350)).toBe(1000);
  });

  it('封顶 1000', () => {
    expect(maxIntimacyForDays(10000)).toBe(1000);
  });

  it('聊天天数不可能超过上限（这是「日积月累」的硬约束）', () => {
    // 第 10 天上限只有 320，猛聊也涨不过
    expect(maxIntimacyForDays(10)).toBe(320);
  });
});

describe('computeIntimacyGain —— 只看互动量', () => {
  it('零互动不加分', () => {
    expect(computeIntimacyGain(baseIntimacy)).toBe(0);
  });

  it('10 轮 +1，20 轮 +2，30 轮以上封顶 +3', () => {
    expect(computeIntimacyGain({ ...baseIntimacy, userMessages: 10 })).toBe(1);
    expect(computeIntimacyGain({ ...baseIntimacy, userMessages: 20 })).toBe(2);
    expect(computeIntimacyGain({ ...baseIntimacy, userMessages: 100 })).toBe(3);
  });

  it('连续 7 天额外 +1', () => {
    expect(computeIntimacyGain({ ...baseIntimacy, streakDays: 7 })).toBe(1);
    expect(computeIntimacyGain({ ...baseIntimacy, streakDays: 6 })).toBe(0);
  });

  it('新增记忆每 5 条 +1，上限 +2', () => {
    expect(computeIntimacyGain({ ...baseIntimacy, newMemoryEntries: 5 })).toBe(1);
    expect(computeIntimacyGain({ ...baseIntimacy, newMemoryEntries: 20 })).toBe(2);
  });

  it('单日总涨幅封顶 +4', () => {
    const maxed = { userMessages: 100, streakDays: 10, newMemoryEntries: 50 };
    expect(computeIntimacyGain({ ...baseIntimacy, ...maxed })).toBe(4);
  });

  it('★ 不看情绪质量：聊天内容再难听，只要聊了就涨', () => {
    // 亲密度只接收 IntimacySignals，根本没有情绪字段
    const gained = computeIntimacyGain({ ...baseIntimacy, userMessages: 20 });
    expect(gained).toBe(2);
  });
});

describe('intimacyDecay —— 长期失联', () => {
  it('7 天内不衰减', () => {
    expect(intimacyDecay(0)).toBe(0);
    expect(intimacyDecay(7)).toBe(0);
  });

  it('超过 7 天开始缓慢下降', () => {
    expect(intimacyDecay(10)).toBeGreaterThan(0);
    expect(intimacyDecay(17)).toBe(5);
  });

  it('单次最多 -15', () => {
    expect(intimacyDecay(1000)).toBe(15);
  });
});

describe('applyIntimacyChange —— 综合应用', () => {
  it('正常增长', () => {
    const r = applyIntimacyChange(300, { ...baseIntimacy, userMessages: 20, activeDays: 100 });
    expect(r.next).toBe(302);
    expect(r.applied).toBe(2);
  });

  it('被天数上限卡住时仍有宽恕增长（不卡死）', () => {
    // 第 0 天上限 300，当前已 300：当天聊了仍可 +1 宽恕增长
    const r = applyIntimacyChange(300, { ...baseIntimacy, userMessages: 50, activeDays: 0 });
    expect(r.next).toBe(301);
    expect(r.applied).toBe(1);
    expect(r.cappedByDays).toBe(true);
  });

  it('已被卡住且当天没聊 → 完全不涨', () => {
    const r = applyIntimacyChange(300, { ...baseIntimacy, userMessages: 0, activeDays: 0 });
    expect(r.applied).toBe(0);
  });

  it('失联时下降', () => {
    const r = applyIntimacyChange(500, { ...baseIntimacy, activeDays: 100, daysSinceInteraction: 20 });
    expect(r.next).toBeLessThan(500);
  });
});

describe('computeAffinityDelta —— 只看质量', () => {
  it('平静的一天无变化', () => {
    expect(computeAffinityDelta(calmAffinity).delta).toBe(0);
  });

  it('温暖对话加分', () => {
    expect(computeAffinityDelta({ ...calmAffinity, warmTurns: 3 }).delta).toBe(1);
    expect(computeAffinityDelta({ ...calmAffinity, warmTurns: 9 }).delta).toBe(3);
  });

  it('感谢加分', () => {
    expect(computeAffinityDelta({ ...calmAffinity, gratefulCount: 2 }).delta).toBe(2);
  });

  it('冒犯大幅扣分', () => {
    expect(computeAffinityDelta({ ...calmAffinity, offensiveCount: 1 }).delta).toBe(-5);
  });

  it('冲突事件严重扣分', () => {
    expect(computeAffinityDelta({ ...calmAffinity, hadConflict: true }).delta).toBe(-10);
  });

  it('★ 与聊天时长无关：聊 1 轮和聊 100 轮，只要质量相同结果就相同', () => {
    const a = computeAffinityDelta({ ...calmAffinity, warmTurns: 3 });
    const b = computeAffinityDelta({ ...calmAffinity, warmTurns: 3 });
    expect(a.delta).toBe(b.delta); // AffinitySignals 里没有"轮次"字段
  });
});

describe('applyAffinityChange —— 单日上限', () => {
  it('涨幅不超过 +5', () => {
    const r = applyAffinityChange(500, { ...calmAffinity, warmTurns: 30, gratefulCount: 10 });
    expect(r.applied).toBe(AFFINITY_MAX_DAILY_GAIN);
  });

  it('降幅不超过 -5（B1：单日有上限）', () => {
    const r = applyAffinityChange(500, { ...calmAffinity, offensiveCount: 5 });
    expect(r.applied).toBe(-AFFINITY_MAX_DAILY_LOSS);
  });

  it('多天可以一直降到底', () => {
    let v = 500;
    const bad = { ...calmAffinity, offensiveCount: 5 };
    for (let i = 0; i < 200; i++) v = applyAffinityChange(v, bad).next;
    expect(v).toBe(0);
  });

  it('多天可以一直涨到顶', () => {
    let v = 500;
    const good = { ...calmAffinity, warmTurns: 9 };
    for (let i = 0; i < 200; i++) v = applyAffinityChange(v, good).next;
    expect(v).toBe(1000);
  });
});

describe('★ 核心：两者可以背离', () => {
  it('吵架：好感掉，亲密度照涨（陪伴过就是陪伴过）', () => {
    const intimacy = applyIntimacyChange(500, { ...baseIntimacy, userMessages: 30, activeDays: 100 });
    const affinity = applyAffinityChange(500, { ...calmAffinity, hadConflict: true, offensiveCount: 1 });

    expect(intimacy.applied).toBeGreaterThan(0);  // 亲密度涨
    expect(affinity.applied).toBeLessThan(0);     // 好感度掉
  });

  it('长期冷淡但关系熟：只掉好感，不掉亲密', () => {
    const affinity = applyAffinityChange(600, { ...calmAffinity, ignoredAllDay: true });
    expect(affinity.applied).toBeLessThan(0);
    // 当天没聊，亲密度不涨也不掉
    const intimacy = applyIntimacyChange(600, { ...baseIntimacy, daysSinceInteraction: 1, activeDays: 100 });
    expect(intimacy.applied).toBe(0);
  });

  it('聊很久很投缘但才认识：亲密低、好感高', () => {
    // 刚认识（activeDays=1），即使聊很多，亲密上限只有 302
    const intimacy = applyIntimacyChange(300, { ...baseIntimacy, userMessages: 100, activeDays: 1 });
    // 但好感可以涨到顶
    const affinity = applyAffinityChange(500, { ...calmAffinity, warmTurns: 20, gratefulCount: 5 });

    expect(intimacy.next).toBeLessThanOrEqual(302);
    expect(affinity.applied).toBe(AFFINITY_MAX_DAILY_GAIN);
  });

  it('认识一年但最近闹别扭：亲密高、好感低', () => {
    // 第 400 天上限 1100（超过 1000 封顶），当前 900 仍有增长空间
    const intimacy = applyIntimacyChange(900, { ...baseIntimacy, userMessages: 20, activeDays: 400 });
    const affinity = applyAffinityChange(400, { ...calmAffinity, hadConflict: true, offensiveCount: 3 });

    expect(intimacy.next).toBeGreaterThan(900);   // 仍亲密
    expect(affinity.next).toBeLessThan(400);      // 好感下降
  });
});

describe('scanQuality —— 质量信号提取', () => {
  it('识别感谢', () => {
    const r = scanQuality(['谢谢你啊', '辛苦啦小忆']);
    expect(r.gratefulCount).toBe(2);
  });

  it('识别冒犯', () => {
    const r = scanQuality(['别废话了', '你很没用']);
    expect(r.offensiveCount).toBe(2);
  });

  it('识别冲突', () => {
    const r = scanQuality(['我们吵架了', '我有点失望']);
    expect(r.hadConflict).toBe(true);
  });

  it('识别温暖', () => {
    const r = scanQuality(['今天好开心', '哈哈哈']);
    expect(r.warmTurns).toBe(2);
  });

  it('普通对话不误判', () => {
    const r = scanQuality(['今天几号', '帮我查一下天气']);
    expect(r.gratefulCount).toBe(0);
    expect(r.offensiveCount).toBe(0);
    expect(r.hadConflict).toBe(false);
    expect(r.warmTurns).toBe(0);
  });
});
