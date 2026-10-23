import { describe, expect, it } from 'vitest';
import { decayFactor, inferTag, mergeMoodOffset, sessionMoodNote } from './session-state';

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

describe('★ decayFactor —— 与文档「约 12 分钟衰减」对齐', () => {
  it('0 分钟不衰减', () => {
    expect(decayFactor(0)).toBe(1);
  });

  it('12 分钟后基本消散（≤ 5%）', () => {
    expect(decayFactor(12)).toBeLessThanOrEqual(0.05);
  });

  it('半衰期约 2.8 分钟', () => {
    expect(decayFactor(2.77)).toBeCloseTo(0.5, 1);
  });

  it('单调递减', () => {
    const pts = [0, 1, 3, 6, 12, 24].map(decayFactor);
    for (let i = 1; i < pts.length; i++) expect(pts[i]).toBeLessThan(pts[i - 1]);
  });

  it('负数时间按 0 处理（防系统时钟回拨）', () => {
    expect(decayFactor(-5)).toBe(1);
  });

  it('实际残留量：happy(+40) 在几个时间点的值', () => {
    const at = (m: number) => Math.round(40 * decayFactor(m));
    expect(at(0)).toBe(40);
    expect(at(3)).toBeLessThan(40);
    expect(at(12)).toBeLessThanOrEqual(2);
  });
});