import { describe, expect, it } from 'vitest';
import { inferTag, mergeMoodOffset, sessionMoodNote } from './session-state';

describe('inferTag —— 从对话文本推断即时情绪', () => {
  it('开心', () => {
    expect(inferTag('太好了！', '嘿嘿')).toBe('happy');
    expect(inferTag('搞定了', '真棒')).toBe('happy');
  });

  it('低落', () => {
    expect(inferTag('今天好难过', '别难过了')).toBe('low');
    expect(inferTag('有点emo', '')).toBe('low');
  });

  it('疲惫', () => {
    expect(inferTag('好累啊', '')).toBe('tired');
    expect(inferTag('昨晚熬夜了', '')).toBe('tired');
  });

  it('忙碌', () => {
    expect(inferTag('我在忙', '')).toBe('busy');
  });

  it('中性', () => {
    expect(inferTag('今天几号', '')).toBe('neutral');
    expect(inferTag('帮我查个东西', '好的')).toBe('neutral');
  });

  it('弱正面词不误判为开心', () => {
    expect(inferTag('不错', '嗯')).toBe('neutral');
  });

  it('★ 否定情绪不误判："我不难过了"不等于低落', () => {
    expect(inferTag('我不难过了，已经想开了', '')).toBe('neutral');
  });

  it('★ 负面优先级高于正面："烦死了但最后搞定了"仍判低落', () => {
    expect(inferTag('烦死了，不过最后终于搞定了', '')).toBe('low');
  });

  it('★ 被否定的疲惫不判疲惫："不累了"', () => {
    expect(inferTag('我现在不累了', '')).toBe('neutral');
  });
});

describe('sessionMoodNote —— 残留描述', () => {
  it('无残留返回空', () => {
    expect(sessionMoodNote({ offset: 0, label: 'neutral', at: Date.now() })).toBe('');
  });

  it('开心残留有描述', () => {
    const s = sessionMoodNote({ offset: 40, label: 'happy', at: Date.now() });
    expect(s).toContain('轻快');
    expect(s).toContain('+40');
  });

  it('低落残留有描述', () => {
    const s = sessionMoodNote({ offset: -30, label: 'low', at: Date.now() });
    expect(s).toContain('低落');
  });
});

describe('mergeMoodOffset —— 情绪合并（纯函数）', () => {
  it('★ 中性消息不冲淡旧情绪、不改标签', () => {
    // 上一轮开心（+40 happy），这一轮说句中性话，不应该把情绪重置
    const r = mergeMoodOffset({ offset: 40, label: 'happy' }, 0, 'neutral');
    expect(r.offset).toBe(40);
    expect(r.label).toBe('happy');
  });

  it('★ 有情绪的新消息：新情绪占主导70%', () => {
    // 上一轮开心+40，这一轮低落-30，合成 = -30*0.7 + 40*0.3 = -9
    const r = mergeMoodOffset({ offset: 40, label: 'happy' }, -30, 'low');
    expect(r.label).toBe('low');
    expect(r.offset).toBe(-9);
  });

  it('边界钳制在 ±100', () => {
    expect(mergeMoodOffset({ offset: 100, label: 'happy' }, 40, 'happy').offset).toBeLessThanOrEqual(100);
    expect(mergeMoodOffset({ offset: -100, label: 'low' }, -30, 'low').offset).toBeGreaterThanOrEqual(-100);
  });
});