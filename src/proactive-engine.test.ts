import { describe, expect, it } from 'vitest';
import {
  BASE_COOLDOWN_MINUTES,
  SILENCE_MINUTES,
  decideProactive,
  extractPendingTopics,
  hourActivityWeight,
  type DecisionInput,
  type UserProfile,
} from './proactive-engine';

const baseProfile = (over: Partial<UserProfile> = {}): UserProfile => ({
  hourlyActivity: new Array(24).fill(0),
  totalMessages: 0,
  minutesSinceLastUserMsg: 600, // 10 小时前
  minutesSinceLastProactive: null,
  repliesAfterLastProactive: 0,
  ...over,
});

const baseEnv = (over = {}) => ({
  hour: 15,
  isRestDay: false,
  weatherChanged: false,
  isSpecialDay: false,
  ...over,
});

const baseInput = (over: Partial<DecisionInput> = {}): DecisionInput => ({
  profile: baseProfile(),
  env: baseEnv(),
  pendingTopics: [],
  level: 'normal',
  ...over,
});

describe('hourActivityWeight', () => {
  it('无数据时返回中性权重', () => {
    expect(hourActivityWeight(new Array(24).fill(0), 15)).toBe(0.3);
  });

  it('活跃小时权重高', () => {
    const activity = new Array(24).fill(0);
    activity[15] = 10;
    activity[9] = 5;
    expect(hourActivityWeight(activity, 15)).toBe(1);
    expect(hourActivityWeight(activity, 9)).toBe(0.5);
    expect(hourActivityWeight(activity, 3)).toBe(0);
  });
});

describe('decideProactive —— 硬性否决', () => {
  it('用户刚聊过（静默期）直接不发', () => {
    const d = decideProactive(
      baseInput({ profile: baseProfile({ minutesSinceLastUserMsg: SILENCE_MINUTES - 1 }) }),
    );
    expect(d.shouldSend).toBe(false);
    expect(d.reasons[0]).toContain('刚聊过');
  });

  it('冷却期内不发', () => {
    const d = decideProactive(
      baseInput({
        profile: baseProfile({ minutesSinceLastProactive: BASE_COOLDOWN_MINUTES - 10 }),
      }),
    );
    expect(d.shouldSend).toBe(false);
    expect(d.reasons[0]).toContain('冷却');
  });

  it('上次未回复时冷却时间翻倍', () => {
    const d = decideProactive(
      baseInput({
        profile: baseProfile({
          minutesSinceLastProactive: BASE_COOLDOWN_MINUTES * 2 - 10, // 未到 3 倍
          repliesAfterLastProactive: 0,
        }),
      }),
    );
    expect(d.shouldSend).toBe(false);
    expect(d.reasons[0]).toContain('上次未回复');
  });
});

describe('decideProactive —— 打分', () => {
  it('有近期待跟进事项时分数显著提高', () => {
    const without = decideProactive(baseInput());
    const withTopic = decideProactive(
      baseInput({ pendingTopics: [{ content: '网络层还没修好', daysAgo: 1 }] }),
    );
    expect(withTopic.score).toBeGreaterThan(without.score);
    expect(withTopic.topics.length).toBeGreaterThan(0);
    expect(withTopic.topics[0]).toContain('网络层');
  });

  it('天气变化 + 特殊日期叠加加分', () => {
    const plain = decideProactive(baseInput());
    const rich = decideProactive(baseInput({ env: baseEnv({ weatherChanged: true, isSpecialDay: true }) }));
    expect(rich.score).toBeGreaterThan(plain.score);
    expect(rich.topics.length).toBeGreaterThanOrEqual(2);
  });

  it('深夜强降权，即使有事由也不发', () => {
    const d = decideProactive(
      baseInput({
        env: baseEnv({ hour: 3 }),
        pendingTopics: [{ content: '某事', daysAgo: 1 }],
      }),
    );
    expect(d.shouldSend).toBe(false);
    expect(d.reasons.some((r) => r.includes('深夜'))).toBe(true);
  });

  it('活跃时段加分', () => {
    const activity = new Array(24).fill(0);
    activity[15] = 20;
    const active = decideProactive(baseInput({ profile: baseProfile({ hourlyActivity: activity }) }));
    const inactive = decideProactive(
      baseInput({ profile: baseProfile({ hourlyActivity: activity }), env: baseEnv({ hour: 3 }) }),
    );
    expect(active.score).toBeGreaterThan(inactive.score);
  });

  it('有事由 + 长时间没聊 → 达到发送阈值', () => {
    const d = decideProactive(
      baseInput({
        profile: baseProfile({ minutesSinceLastUserMsg: 60 * 30 }), // 30 小时
        pendingTopics: [{ content: '昨天提到的项目', daysAgo: 1 }],
        env: baseEnv({ hour: 15 }),
      }),
    );
    expect(d.shouldSend).toBe(true);
    expect(d.score).toBeGreaterThanOrEqual(50);
  });

  it('强度档影响阈值：active 更容易发', () => {
    const input = baseInput({
      profile: baseProfile({ minutesSinceLastUserMsg: 60 * 10 }),
      pendingTopics: [{ content: '某事', daysAgo: 5 }],
    });
    const quiet = decideProactive({ ...input, level: 'quiet' });
    const active = decideProactive({ ...input, level: 'active' });
    expect(quiet.score).toBe(active.score); // 分数相同
    if (quiet.shouldSend === false) {
      expect(active.shouldSend === true || active.score < 35).toBe(true);
    }
  });
});

describe('extractPendingTopics', () => {
  const memory = `# 长期记忆

## 关于用户
- [2026-10-20] 用户喜欢蓝色。

## 进行中的事项
- [2026-10-21] 正在开发跨端聊天软件，网络层还没修好。
- [2026-09-01] 远古事项（远超 14 天）。
- [2026-10-22] 今天要做的事。
`;

  it('提取近 14 天的事项并按新旧排序', () => {
    const topics = extractPendingTopics(memory, new Date('2026-10-22T12:00:00+08:00'));
    expect(topics.length).toBe(2);
    expect(topics[0].content).toContain('今天要做的事');
    expect(topics[1].content).toContain('网络层');
    expect(topics[0].daysAgo).toBeLessThanOrEqual(topics[1].daysAgo);
  });

  it('不把「关于用户」区块的条目混进来', () => {
    const topics = extractPendingTopics(memory, new Date('2026-10-22T12:00:00+08:00'));
    expect(topics.every((t) => !t.content.includes('喜欢蓝色'))).toBe(true);
  });

  it('没有该区块时返回空', () => {
    expect(extractPendingTopics('# 长期记忆\n\n## 关于用户\n- x', new Date())).toEqual([]);
  });

  it('忽略超过 14 天的事项', () => {
    const topics = extractPendingTopics(memory, new Date('2026-10-22T12:00:00+08:00'));
    expect(topics.every((t) => t.daysAgo <= 14)).toBe(true);
  });
});

describe('固定时段（早晚问候）', () => {
  it('★ 睡前时段即使活跃度为 0 也会发（以前永远凑不够 50 分）', () => {
    const d = decideProactive(
      baseInput({
        env: baseEnv({ hour: 23 }),
        profile: baseProfile({ hourlyActivity: new Array(24).fill(0) }),
        slot: 'evening',
      }),
    );
    expect(d.shouldSend).toBe(true);
    expect(d.reasons.join()).toContain('睡前');
  });

  it('深夜惩罚不再打掉睡前窗口', () => {
    const evening = decideProactive(
      baseInput({ env: baseEnv({ hour: 23 }), slot: 'evening' }),
    );
    const random = decideProactive(
      baseInput({ env: baseEnv({ hour: 23 }), slot: 'random' }),
    );
    expect(evening.reasons.join()).not.toContain('深夜时段');
    expect(random.reasons.join()).toContain('深夜时段');
    expect(evening.score).toBeGreaterThan(random.score);
  });

  it('早上时段同理', () => {
    const d = decideProactive(
      baseInput({ env: baseEnv({ hour: 8 }), slot: 'morning' }),
    );
    expect(d.shouldSend).toBe(true);
    expect(d.reasons.join()).toContain('早安');
  });

  it('静默期仍然否决固定问候（刚聊过就不打扰）', () => {
    const d = decideProactive(
      baseInput({
        env: baseEnv({ hour: 23 }),
        profile: baseProfile({ minutesSinceLastUserMsg: 5 }),
        slot: 'evening',
      }),
    );
    expect(d.shouldSend).toBe(false);
    expect(d.reasons.join()).toContain('刚聊过');
  });

  it('随机消息不受固定时段加成影响', () => {
    const d = decideProactive(
      baseInput({ env: baseEnv({ hour: 15 }), slot: 'random' }),
    );
    expect(d.shouldSend).toBe(false);
  });
});
