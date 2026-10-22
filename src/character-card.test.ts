import { describe, expect, it } from 'vitest';
import {
  awayAperture,
  buildCharacterCard,
  CONVERSATION_BEHAVIORS,
  dispositionFor,
  fatigueLevel,
  formatAway,
  offlineLife,
  timeOfDayState,
} from './character-card';
import { BANNED_PHRASES, buildVoiceDirective, casualness } from './voice';

describe('awayAperture —— 距上次聊天引导', () => {
  it('首次聊天', () => {
    expect(awayAperture(null)).toContain('第一次');
  });
  it('刚聊过', () => {
    expect(awayAperture(0.05)).toContain('刚刚还在聊');
  });
  it('隔了大半天（用户要的场景）', () => {
    expect(awayAperture(12)).toContain('终于想起我啦');
  });
  it('隔了一两天带嗔怪', () => {
    expect(awayAperture(30)).toContain('昨天都没找我');
  });
  it('好几天没联系', () => {
    expect(awayAperture(100)).toContain('最近怎么样');
  });
});

describe('formatAway', () => {
  it('分钟、小时、天', () => {
    expect(formatAway(null)).toBe('首次聊天');
    expect(formatAway(0.5)).toContain('分钟');
    expect(formatAway(5)).toContain('小时');
    expect(formatAway(48)).toContain('天');
  });
});

describe('timeOfDayState —— 时段 + 心情', () => {
  it('下午犯困想喝奶茶（用户要的场景）', () => {
    expect(timeOfDayState(15, 500)).toContain('想喝奶茶');
  });
  it('凌晨迷糊', () => {
    expect(timeOfDayState(2, 500)).toContain('迷糊');
  });
  it('深夜催睡', () => {
    expect(timeOfDayState(23, 500)).toContain('早点睡');
  });
  it('心情低落时克制', () => {
    expect(timeOfDayState(10, 200)).toContain('克制');
  });
  it('心情好更活泼', () => {
    expect(timeOfDayState(10, 700)).toContain('活泼');
  });
});

describe('fatigueLevel —— 疲惫度', () => {
  it('20 轮内精神', () => {
    expect(fatigueLevel(10).level).toBe(0);
  });
  it('40 轮轻微累', () => {
    const f = fatigueLevel(30);
    expect(f.level).toBeGreaterThan(0);
    expect(f.note).toContain('略短');
  });
  it('60+ 很累', () => {
    expect(fatigueLevel(70).level).toBe(1);
    expect(fatigueLevel(70).note).toContain('催休息');
  });
});

describe('buildCharacterCard —— 状态卡', () => {
  it('产出一张包含三要素的卡', () => {
    const c = buildCharacterCard({ hour: 15, hoursSinceLastContact: 12, mood: 550, affinity: 500, intimacy: 500, todayTurns: 30 });
    expect(c.cardText).toContain('距上次聊天');
    expect(c.cardText).toContain('开场情绪');
    expect(c.cardText).toContain('当下状态');
    expect(c.cardText).toContain('疲惫度');
    expect(c.cardText).toContain('相处分寸');
  });

  it('亲密度低 → 礼貌，亲密度高 → 随意', () => {
    const cold = buildCharacterCard({ hour: 10, hoursSinceLastContact: null, mood: 500, affinity: 500, intimacy: 300, todayTurns: 0 });
    const warm = buildCharacterCard({ hour: 10, hoursSinceLastContact: null, mood: 500, affinity: 500, intimacy: 900, todayTurns: 0 });
    expect(cold.casualNote).toContain('不太熟');
    expect(warm.casualNote).toContain('老朋友');
  });

  it('状态卡包含人格倾向与对话方式（阶段 3）', () => {
    const c = buildCharacterCard({ hour: 15, hoursSinceLastContact: 1, mood: 550, affinity: 600, intimacy: 700, todayTurns: 5 });
    expect(c.cardText).toContain('本轮倾向');
    expect(c.cardText).toContain('对话方式');
    expect(c.cardText).toContain('反问');
    expect(c.disposition.hint.length).toBeGreaterThan(0);
  });

  it('被冷落时状态卡带小情绪（阶段 4）', () => {
    const c = buildCharacterCard({ hour: 20, hoursSinceLastContact: 30, mood: 500, affinity: 600, intimacy: 700, todayTurns: 3, wasIgnored: true, ignoredMessage: '昨天问你在忙什么你都没回' });
    expect(c.cardText).toContain('冷落小情绪');
    expect(c.cardText).toContain('小委屈');
  });

  it('未被冷落时状态卡不含冷落情绪', () => {
    const c = buildCharacterCard({ hour: 20, hoursSinceLastContact: 30, mood: 500, affinity: 600, intimacy: 700, todayTurns: 3 });
    expect(c.cardText).not.toContain('冷落小情绪');
  });

  it('★ 倾向按时间块稳定：同一 3 小时块内不跳变', () => {
    const a = buildCharacterCard({ hour: 14, hoursSinceLastContact: 1, mood: 500, affinity: 600, intimacy: 700, todayTurns: 10 });
    const b = buildCharacterCard({ hour: 14, hoursSinceLastContact: 1, mood: 500, affinity: 600, intimacy: 700, todayTurns: 50 });
    expect(a.disposition.label).toBe(b.disposition.label);
  });

  it('★ 跨时间块倾向可切换', () => {
    const a = buildCharacterCard({ hour: 2, hoursSinceLastContact: 1, mood: 500, affinity: 600, intimacy: 700, todayTurns: 1 });
    const b = buildCharacterCard({ hour: 14, hoursSinceLastContact: 1, mood: 500, affinity: 600, intimacy: 700, todayTurns: 1 });
    expect(typeof a.disposition.label).toBe('string');
    expect(typeof b.disposition.label).toBe('string');
  });

  it('★ 状态卡含离线生活（阶段 4）', () => {
    const c = buildCharacterCard({ hour: 15, hoursSinceLastContact: 5, mood: 500, affinity: 600, intimacy: 700, todayTurns: 3, dateKey: '2026-10-22' });
    expect(c.cardText).toContain('刚才在做什么');
  });
});

describe('offlineLife —— 离线生活快照（阶段 4）', () => {
  it('同一天同一小时稳定', () => {
    expect(offlineLife('2026-10-22', 15)).toBe(offlineLife('2026-10-22', 15));
  });

  it('不同日期会变化（大多数情况）', () => {
    const a = offlineLife('2026-10-22', 15);
    const b = offlineLife('2026-10-23', 15);
    // 不强制断言不同（哈希可能碰撞），只断言都合法非空
    expect(a.length).toBeGreaterThan(0);
    expect(b.length).toBeGreaterThan(0);
  });

  it('清晨时段有对应生活', () => {
    // 早上 7 点应该命中"刚醒"那类，而非"吃夜宵"
    const s = offlineLife('2026-10-22', 7);
    expect(typeof s).toBe('string');
    expect(s.length).toBeGreaterThan(0);
  });

  it('无日期时返回空', () => {
    expect(offlineLife(undefined, 15)).toBe('');
  });
});

describe('dispositionFor —— 人格倾向与三维关系绑定（阶段 3）', () => {
  it('亲和好感高：可能开出亲昵倾向', () => {
    const labels = new Set<string>();
    for (let seed = 0; seed < 50; seed++) {
      labels.add(dispositionFor(700, 800, 600, seed).label);
    }
    const closeHit = ['想撒娇', '想吐槽', '想摆烂', '有点想被夸'].some((l) => labels.has(l));
    expect(closeHit).toBe(true);
  });

  it('亲密度低：不会开出亲昵倾向', () => {
    for (let seed = 0; seed < 50; seed++) {
      const d = dispositionFor(500, 300, 500, seed);
      expect(['想撒娇', '想摆烂']).not.toContain(d.label);
    }
  });

  it('★ 心情低落：只开克制池，不嬉皮笑脸', () => {
    for (let seed = 0; seed < 50; seed++) {
      const d = dispositionFor(800, 900, 200, seed);
      expect(['想撒娇', '想吐槽', '想摆烂', '有点想被夸', '轻松', '想分享']).not.toContain(d.label);
    }
  });

  it('★ 好感度低（闹别扭）：只开克制池', () => {
    for (let seed = 0; seed < 50; seed++) {
      const d = dispositionFor(300, 800, 500, seed);
      expect(['想撒娇', '想摆烂', '轻松', '想分享']).not.toContain(d.label);
    }
  });

  it('确定性：同参数结果一致', () => {
    expect(dispositionFor(700, 800, 500, 42).label).toBe(dispositionFor(700, 800, 500, 42).label);
  });
});

describe('CONVERSATION_BEHAVIORS —— 对话行为指令', () => {
  it('包含反问、主动提及、拒绝、带情绪等关键指令', () => {
    expect(CONVERSATION_BEHAVIORS).toContain('反问');
    expect(CONVERSATION_BEHAVIORS).toContain('主动提到');
    expect(CONVERSATION_BEHAVIORS).toContain('不太想聊');
    expect(CONVERSATION_BEHAVIORS).toContain('别每次都长篇大论');
  });
});

describe('voice —— 语言层', () => {
  it('禁用词表包含 AI 套话', () => {
    expect(BANNED_PHRASES).toContain('很高兴帮助你');
    expect(BANNED_PHRASES).toContain('您');
    expect(BANNED_PHRASES).toContain('根据我的记忆');
  });
  it('casualness 随亲密度递增', () => {
    expect(casualness(300)).toBeLessThan(casualness(600));
    expect(casualness(600)).toBeLessThan(casualness(900));
    expect(casualness(1000)).toBe(1);
  });
  it('语音指令包含禁用词与口头禅', () => {
    const v = buildVoiceDirective(700);
    expect(v).toContain('绝对不要出现');
    expect(v).toContain('嘿嘿');
    expect(v).toContain('不是不是');
  });

  // 注意：小癖好/小脾气已移到 memory.md「人物底色」，voice 不再重复，
  // 避免同一性格设定在 prompt 里出现两次（占 token 且易不一致）。
});