import { describe, expect, it } from 'vitest';
import { buildVoiceDirective, casualness, recentOpeners, signatureFor } from './voice';

describe('casualness', () => {
  it('亲密度映射到 0~1，并做边界钳制', () => {
    expect(casualness(300)).toBe(0);
    expect(casualness(1000)).toBe(1);
    expect(casualness(100)).toBe(0);
    expect(casualness(1200)).toBe(1);
    expect(casualness(650)).toBeCloseTo(0.5, 2);
  });
});

describe('buildVoiceDirective —— 只指向人设与记忆，不给风格清单', () => {
  it('只讲「按记忆里那个人来说」与「长短随意」', () => {
    const d = buildVoiceDirective(900);
    expect(d).toContain('记忆里那个人');
    expect(d).toContain('想短就短，想长就长');
  });

  it('不再有禁用词/颜文字频率/口头禅/断句/情绪清单', () => {
    const d = buildVoiceDirective(900);
    for (const banned of ['绝对不要出现', '每 3~4 条', '口头禅：', '必须断句', '别给人下性格判断']) {
      expect(d).not.toContain(banned);
    }
  });

  it('体积很小（不再是一张清单）', () => {
    const bytes = new TextEncoder().encode(buildVoiceDirective(900)).length;
    expect(bytes).toBeLessThan(400);
  });
});

describe('signatureFor —— 口头禅随关系演化', () => {
  it('刚认识时只是普通语气词', () => {
    expect(signatureFor(100).happy).toBe('哈哈');
  });
  it('熟了才出现口头禅', () => {
    expect(signatureFor(500).happy).toBe('嘿嘿');
  });
  it('很亲近后变得更放开', () => {
    expect(signatureFor(900).happy).toBe('哼哼');
  });
});

describe('recentOpeners', () => {
  it('取最近几条的开头并去掉空白', () => {
    expect(recentOpeners(['  诶？你说', '哈哈，好吧', '行', '最后一条'])).toEqual([
      '哈哈，好吧',
      '行',
      '最后一条',
    ]);
  });
  it('最多截 6 个字', () => {
    expect(recentOpeners(['一二三四五六七八'])).toEqual(['一二三四五六']);
  });
  it('空文本被跳过', () => {
    expect(recentOpeners(['', '   ', '好'])).toEqual(['好']);
  });
});
