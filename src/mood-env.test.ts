import { describe, expect, it } from 'vitest';
import {
  applyMoodDrift,
  applyMoodDriftAccumulated,
  computeMoodDrift,
  MOOD_MAX_DRIFT_DAILY,
  restDayDelta,
  seasonDelta,
  timeOfDayDelta,
  weatherDelta,
  type MoodEnvironment,
} from './mood-env';

describe('timeOfDayDelta', () => {
  it('凌晨最低', () => {
    expect(timeOfDayDelta(3).delta).toBe(-25);
  });

  it('午间最高', () => {
    expect(timeOfDayDelta(12).delta).toBe(+12);
  });

  it('深夜偏低', () => {
    expect(timeOfDayDelta(23).delta).toBe(-12);
  });

  it('全天各时段都有定义', () => {
    for (let h = 0; h < 24; h++) {
      expect(typeof timeOfDayDelta(h).delta).toBe('number');
    }
  });
});

describe('weatherDelta', () => {
  it('暴雨最负面', () => {
    expect(weatherDelta({ city: '北京', temp_c: 25, desc: '雷雨' }).delta).toBe(-20);
  });

  it('晴天正面', () => {
    expect(weatherDelta({ city: '北京', temp_c: 25, desc: '晴' }).delta).toBe(+10);
  });

  it('阴天轻微负面', () => {
    expect(weatherDelta({ city: '北京', temp_c: 25, desc: '阴' }).delta).toBe(-5);
  });

  it('无天气数据时无影响', () => {
    expect(weatherDelta(null).delta).toBe(0);
  });

  it('极端温度有影响', () => {
    expect(weatherDelta({ city: 'x', temp_c: 38, desc: '未知' }).delta).toBe(-10);
    expect(weatherDelta({ city: 'x', temp_c: -5, desc: '未知' }).delta).toBe(-8);
  });
});

describe('seasonDelta', () => {
  it('春天正面', () => {
    expect(seasonDelta(4).delta).toBe(+8);
  });

  it('冬天负面', () => {
    expect(seasonDelta(12).delta).toBe(-6);
  });
});

describe('restDayDelta', () => {
  it('休息日清晨负面（怕被打扰睡眠）', () => {
    expect(restDayDelta(7).delta).toBe(-8);
  });

  it('休息日白天正面', () => {
    expect(restDayDelta(15).delta).toBe(+12);
  });
});

describe('computeMoodDrift', () => {
  const base: MoodEnvironment = { hour: 12, isRestDay: false, weather: null, month: 4 };

  it('午间 + 春天 = 正面', () => {
    const d = computeMoodDrift(base);
    expect(d.delta).toBeGreaterThan(0);
    expect(d.reasons.length).toBeGreaterThan(0);
  });

  it('凌晨 + 暴雨 + 冬天 = 强负面', () => {
    const d = computeMoodDrift({
      hour: 3,
      isRestDay: false,
      weather: { city: 'x', temp_c: 5, desc: '暴雨' },
      month: 12,
    });
    expect(d.delta).toBeLessThan(-30);
    expect(d.reasons.length).toBeGreaterThanOrEqual(3);
  });

  it('休息日白天叠加正面', () => {
    const workday = computeMoodDrift({ ...base, isRestDay: false });
    const restday = computeMoodDrift({ ...base, isRestDay: true });
    expect(restday.delta).toBeGreaterThan(workday.delta);
  });
});

describe('applyMoodDrift', () => {
  it('正常应用漂移', () => {
    const r = applyMoodDrift(500, { delta: 20, reasons: [] });
    expect(r.mood).toBe(520);
    expect(r.applied).toBe(20);
  });

  it('受单日上限约束', () => {
    const r = applyMoodDrift(500, { delta: 200, reasons: [] }, 80);
    expect(r.mood).toBe(580);
    expect(r.applied).toBe(80);
  });

  it('边界钳制', () => {
    expect(applyMoodDrift(20, { delta: -100, reasons: [] }).mood).toBe(0);
    expect(applyMoodDrift(980, { delta: 100, reasons: [] }).mood).toBe(1000);
  });
});

describe('applyMoodDriftAccumulated —— 单日累计额度', () => {
  const day = (used: number) => ({ dateKey: '2026-10-23', used });

  it('首次应用消耗额度', () => {
    const r = applyMoodDriftAccumulated(500, { delta: 50, reasons: [] }, day(0));
    expect(r.mood).toBe(550);
    expect(r.usage.used).toBe(50);
  });

  it('★ 核心修复：同一天多次漂移不会各自推满 80', () => {
    let mood = 500;
    let usage = day(0);
    // 模拟一天 8 次调用，每次想推 +50
    for (let i = 0; i < 8; i++) {
      const r = applyMoodDriftAccumulated(mood, { delta: 50, reasons: [] }, usage);
      mood = r.mood;
      usage = r.usage;
    }
    // 累计总额度只有 80，所以最多到 580（而不是跑到 900）
    expect(mood).toBe(580);
    expect(Math.abs(usage.used)).toBe(MOOD_MAX_DRIFT_DAILY);
  });

  it('额度用尽后不再变动', () => {
    const r = applyMoodDriftAccumulated(580, { delta: 50, reasons: [] }, day(80));
    expect(r.mood).toBe(580);
    expect(r.applied).toBe(0);
  });

  it('负向漂移同样受限额', () => {
    let mood = 500;
    let usage = day(0);
    for (let i = 0; i < 8; i++) {
      const r = applyMoodDriftAccumulated(mood, { delta: -50, reasons: [] }, usage);
      mood = r.mood;
      usage = r.usage;
    }
    expect(mood).toBe(420);
  });

  it('反向漂移可以抵消已用额度', () => {
    // 已用 +50，现在来了 -30：抵消后剩余 +20
    const r = applyMoodDriftAccumulated(550, { delta: -30, reasons: [] }, day(50));
    expect(r.mood).toBe(520);
    expect(r.usage.used).toBe(20);
  });

  it('零漂移不消耗额度', () => {
    const r = applyMoodDriftAccumulated(500, { delta: 0, reasons: [] }, day(30));
    expect(r.mood).toBe(500);
    expect(r.usage.used).toBe(30);
  });

  it('边界钳制到 0-1000', () => {
    const hi = applyMoodDriftAccumulated(990, { delta: 50, reasons: [] }, day(0));
    expect(hi.mood).toBe(1000);
    const lo = applyMoodDriftAccumulated(10, { delta: -50, reasons: [] }, day(0));
    expect(lo.mood).toBe(0);
  });
});
