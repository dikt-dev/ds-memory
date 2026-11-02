import { describe, expect, it } from 'vitest';
import { buildVoiceDirective, casualness, recentOpeners, recentPhrases, signatureFor } from './voice';

describe('casualness', () => {
  it('亲密度映射到 0~1，并做边界钳制', () => {
    expect(casualness(300)).toBe(0);
    expect(casualness(1000)).toBe(1);
    expect(casualness(100)).toBe(0);
    expect(casualness(1200)).toBe(1);
    expect(casualness(650)).toBeCloseTo(0.5, 2);
  });
});

describe('buildVoiceDirective —— 指向人设，同时给四条机械约束', () => {
  it('先指向「记忆里那个人」，再讲怎么打字', () => {
    const d = buildVoiceDirective(900);
    expect(d).toContain('记忆里那个人');
    expect(d).toContain('像在手机上打字');
  });

  it('长度、括号动作、短回复、反问都有明确约束', () => {
    const d = buildVoiceDirective(900);
    expect(d).toContain('不超过 60 字');
    expect(d).toContain('括号动作基本不写');
    expect(d).toContain('允许只回');
    expect(d).toContain('反问是偶尔的');
  });

  it('不再有禁用词/颜文字频率/口头禅/断句/情绪清单', () => {
    const d = buildVoiceDirective(900);
    for (const banned of ['绝对不要出现', '每 3~4 条', '口头禅：', '必须断句', '别给人下性格判断']) {
      expect(d).not.toContain(banned);
    }
  });

  it('体积控制在 1800 字节内（不是一张清单）', () => {
    const bytes = new TextEncoder().encode(buildVoiceDirective(900)).length;
    expect(bytes).toBeLessThan(1800);
  });
});

describe('recentPhrases', () => {
  it('抓出反复出现的短词，按次数降序', () => {
    const out = recentPhrases(['本小姐就不去了', '本小姐说了算', '行吧本小姐', '今天好累']);
    expect(out[0]).toBe('本小姐');
  });
  it('只出现一次的词不进结果', () => {
    const out = recentPhrases(['早上好', '晚上好']);
    expect(out).toEqual([]);
  });
  it('括号里的动作描写不参与统计', () => {
    const out = recentPhrases(['（顿了顿）行', '（顿了顿）好吧']).filter((w) => w === '顿了顿');
    expect(out).toEqual([]);
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
