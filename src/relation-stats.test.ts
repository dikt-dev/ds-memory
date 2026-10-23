import { describe, expect, it } from 'vitest';
import { detectLowMoodButCompanioned } from './relation-stats';

describe('detectLowMoodButCompanioned —— 陪伴低落情绪', () => {
  it('★ 核心修复：用户低落且有回复 → true', () => {
    expect(detectLowMoodButCompanioned(['好难过', '今天很累', '心情很差'], true)).toBe(true);
  });

  it('用户低落但没有助手回复 → false（没陪伴）', () => {
    expect(detectLowMoodButCompanioned(['好难过', '今天很累'], false)).toBe(false);
  });

  it('用户开心 → false（不需要陪伴低落）', () => {
    expect(detectLowMoodButCompanioned(['今天好开心', '哈哈哈太好笑了'], true)).toBe(false);
  });

  it('没有用户消息 → false', () => {
    expect(detectLowMoodButCompanioned([], true)).toBe(false);
  });

  it('只有极短消息（如"嗯"）不足以判定 → false', () => {
    expect(detectLowMoodButCompanioned(['嗯', '哦'], true)).toBe(false);
  });

  it('半数以上负面才判定为整体低落', () => {
    // 1 负 2 正 → 不足半数
    expect(detectLowMoodButCompanioned(['好难过', '哈哈', '哈哈哈'], true)).toBe(false);
    // 2 负 1 正 → 过半数
    expect(detectLowMoodButCompanioned(['好难过', '今天很累', '哈哈'], true)).toBe(true);
  });
});
