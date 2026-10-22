import { describe, expect, it } from 'vitest';
import { feedbackCooldownMultiplier, type FeedbackStats } from './feedback';

const stats = (over: Partial<FeedbackStats> = {}): FeedbackStats => ({
  total: 10,
  replied: 5,
  replyRate: 0.5,
  avgReplyMinutes: 20,
  hourlyReplyRate: [],
  byKind: [],
  ...over,
});

describe('feedbackCooldownMultiplier', () => {
  it('样本太少时不调整', () => {
    expect(feedbackCooldownMultiplier(stats({ total: 3 }))).toBe(1);
  });

  it('回复率高 → 更主动（冷却缩短）', () => {
    expect(feedbackCooldownMultiplier(stats({ total: 10, replyRate: 0.7 }))).toBe(0.8);
  });

  it('回复率中等 → 正常', () => {
    expect(feedbackCooldownMultiplier(stats({ total: 10, replyRate: 0.4 }))).toBe(1);
  });

  it('回复率偏低 → 冷却拉长', () => {
    expect(feedbackCooldownMultiplier(stats({ total: 10, replyRate: 0.2 }))).toBe(1.5);
  });

  it('基本不回复 → 大幅降低频率', () => {
    expect(feedbackCooldownMultiplier(stats({ total: 10, replyRate: 0.05 }))).toBe(2.5);
  });
});
