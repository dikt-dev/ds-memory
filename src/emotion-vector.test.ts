import { describe, expect, it } from 'vitest';
import {
  EMOTION_MAX,
  EMOTION_MAX_STEP_PER_TURN,
  applyEmotionDelta,
  applyEnvironmentToEmotion,
  decayEmotion,
  decayGrievanceDaily,
  dominantEmotions,
  emptyEmotionVector,
  moodFromVector,
  parseEmotionVector,
} from './emotion-vector';

describe('decayEmotion —— 差异化半衰期', () => {
  it('害羞 15 分钟就散掉大半，依恋还留着', () => {
    const v = { ...emptyEmotionVector(), shyness: 60, attachment: 60 };
    const after = decayEmotion(v, 15);
    expect(after.shyness).toBe(30); // 半衰期 15min → 剩 50%
    expect(after.attachment).toBeGreaterThan(55); // 半衰期 6h → 几乎没变
  });

  it('芥蒂不随时间衰减', () => {
    const v = { ...emptyEmotionVector(), grievance: 50 };
    const after = decayEmotion(v, 60 * 24);
    expect(after.grievance).toBe(50);
  });

  it('衰减到 1 以下归零，不留噪声', () => {
    const v = { ...emptyEmotionVector(), shyness: 3 };
    expect(decayEmotion(v, 120).shyness).toBe(0);
  });

  it('0 分钟不变', () => {
    const v = { ...emptyEmotionVector(), valence: 20 };
    expect(decayEmotion(v, 0)).toEqual(v);
  });
});

describe('applyEmotionDelta —— 单轮限幅', () => {
  it('单维单轮最多 ±30', () => {
    const next = applyEmotionDelta(emptyEmotionVector(), { valence: 100 });
    expect(next.valence).toBe(EMOTION_MAX_STEP_PER_TURN);
  });

  it('总绝对值不超过 ±100', () => {
    const v = { ...emptyEmotionVector(), valence: 95 };
    const next = applyEmotionDelta(v, { valence: 30 });
    expect(next.valence).toBe(EMOTION_MAX);
  });

  it('负向同样生效', () => {
    const next = applyEmotionDelta(emptyEmotionVector(), { valence: -10, fatigue: 5 });
    expect(next.valence).toBe(-10);
    expect(next.fatigue).toBe(5);
  });
});

describe('decayGrievanceDaily', () => {
  it('每天只退 20%', () => {
    expect(decayGrievanceDaily({ ...emptyEmotionVector(), grievance: 80 }).grievance).toBe(64);
  });

  it('低于 8 直接归零（小情绪不跨天）', () => {
    expect(decayGrievanceDaily({ ...emptyEmotionVector(), grievance: 9 }).grievance).toBe(0);
  });
});

describe('dominantEmotions', () => {
  it('按绝对值取前两名', () => {
    const v = { ...emptyEmotionVector(), grievance: 40, valence: 60, shyness: 10 };
    const top = dominantEmotions(v, 15, 2);
    expect(top.map((t) => t.dim)).toEqual(['valence', 'grievance']);
  });

  it('负向 valence 输出「低落」', () => {
    const v = { ...emptyEmotionVector(), valence: -40 };
    expect(dominantEmotions(v)[0].label).toBe('低落');
  });

  it('单向维度（委屈）负值不算情绪', () => {
    const v = { ...emptyEmotionVector(), grievance: -50 };
    expect(dominantEmotions(v, 10)).toHaveLength(0);
  });

  it('低于阈值返回空', () => {
    expect(dominantEmotions({ ...emptyEmotionVector(), shyness: 5 }, 15)).toHaveLength(0);
  });
});

describe('applyEnvironmentToEmotion —— 情绪自己的来源', () => {
  it('凌晨会带来疲惫，且不因重复调用而无上限叠加', () => {
    const env = { hour: 3, isRestDay: false, weather: null, month: 10 };
    let v = emptyEmotionVector();
    for (let i = 0; i < 20; i++) v = applyEnvironmentToEmotion(v, env);
    expect(v.fatigue).toBeLessThanOrEqual(EMOTION_MAX);
    expect(v.fatigue).toBeGreaterThan(0);
  });

  it('晴天午后略微正向', () => {
    const env = { hour: 13, isRestDay: false, weather: { city: '深圳', temp_c: 26, desc: '晴' }, month: 10 };
    const v = applyEnvironmentToEmotion(emptyEmotionVector(), env);
    expect(v.valence).toBeGreaterThan(0);
  });
});

describe('parseEmotionVector', () => {
  it('脏数据回退为中性', () => {
    expect(parseEmotionVector(null)).toEqual(emptyEmotionVector());
    expect(parseEmotionVector({ valence: 'abc' }).valence).toBe(0);
    expect(parseEmotionVector({ grief: 999 }).grievance).toBe(0);
  });
});

describe('moodFromVector —— 心情值从向量派生', () => {
  it('中性 → 500', () => {
    expect(moodFromVector(emptyEmotionVector())).toBe(500);
  });

  it('愉悦抬高、委屈拉低', () => {
    expect(moodFromVector({ ...emptyEmotionVector(), valence: 50 })).toBeGreaterThan(600);
    expect(moodFromVector({ ...emptyEmotionVector(), grievance: 50 })).toBeLessThan(450);
  });

  it('单维打满也不会顶死两端', () => {
    const hi = moodFromVector({ ...emptyEmotionVector(), valence: 100, arousal: 100, attachment: 100 });
    const lo = moodFromVector({ ...emptyEmotionVector(), grievance: 100, fatigue: 100 });
    expect(hi).toBeLessThan(1000);
    expect(lo).toBeGreaterThan(0);
  });

  it('结果被夹在 0~1000', () => {
    expect(moodFromVector({ ...emptyEmotionVector(), grievance: 100, fatigue: 100, valence: -100 })).toBeGreaterThanOrEqual(0);
  });
});
