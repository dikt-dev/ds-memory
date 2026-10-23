import { describe, expect, it } from 'vitest';
import { BANNED_PHRASES, KAOMOJI, buildVoiceDirective, casualness } from './voice';

describe('casualness', () => {
  it('亲密度映射到 0~1，并做边界钳制', () => {
    expect(casualness(300)).toBe(0);
    expect(casualness(1000)).toBe(1);
    expect(casualness(100)).toBe(0); // 低于初始值不出现负数
    expect(casualness(1200)).toBe(1); // 超出上限也不越界
    expect(casualness(650)).toBeCloseTo(0.5, 2);
  });
});

describe('buildVoiceDirective', () => {
  it('包含「日常回复要短」的硬约束', () => {
    const d = buildVoiceDirective(300);
    expect(d).toContain('消息长度（很重要');
    expect(d).toContain('不超过 60 字');
    expect(d).toContain('不要分点');
    expect(d).toContain('不要标题');
  });

  it('包含「像真人」的要求，且限制表演感', () => {
    const d = buildVoiceDirective(300);
    expect(d).toContain('像真人那样说话');
    expect(d).toContain('先接住他刚说的那句');
    expect(d).toContain('（括号动作）一条消息最多一次');
    expect(d).toContain('简短不等于冷淡');
  });

  it('禁用词表前置，且包含「您」这类客服腔', () => {
    const d = buildVoiceDirective(300);
    expect(BANNED_PHRASES).toContain('您');
    expect(d).toContain('"您"');
    expect(d.indexOf('绝对不要出现')).toBeLessThan(d.indexOf('消息长度'));
  });

  it('包含「别把话压得太干」与颜文字规则', () => {
    const d = buildVoiceDirective(900);
    expect(d).toContain('别把话压得太干');
    expect(d).toContain('颜文字');
    expect(d).toContain(KAOMOJI.happy[0]);
    expect(d).toContain('同一条最多一个');
    expect(d).toContain('不用 emoji 表情符号');
  });

  it('刚认识时颜文字更克制', () => {
    expect(buildVoiceDirective(300)).toContain('最多每 6~8 条');
    expect(buildVoiceDirective(900)).not.toContain('最多每 6~8 条');
  });

  it('按亲密度切换口语化程度', () => {
    expect(buildVoiceDirective(300)).toContain('还不太熟');
    expect(buildVoiceDirective(650)).toContain('挺熟了');
    expect(buildVoiceDirective(900)).toContain('非常亲近');
  });
});
