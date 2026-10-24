import { describe, expect, it } from 'vitest';
import {
  BANNED_PHRASES,
  buildVoiceDirective,
  casualness,
  recentOpeners,
  replyTokenBudget,
  signatureFor,
} from './voice';

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
  it('不设固定字数，长短交给语气决定', () => {
    const d = buildVoiceDirective(300);
    expect(d).toContain('不设固定字数');
    expect(d).toContain('第一句给结论');
  });

  it('禁用词表前置，且包含「您」这类客服腔', () => {
    const d = buildVoiceDirective(300);
    expect(BANNED_PHRASES).toContain('您');
    expect(d).toContain('您');
    expect(d.indexOf('绝对不要出现')).toBeLessThan(d.indexOf('## 长度'));
  });

  it('明确禁止 markdown 排版（聊天里出现标题/加粗就出戏）', () => {
    const d = buildVoiceDirective(900);
    expect(d).toContain('markdown');
    expect(d).toContain('加粗');
  });

  it('有语气起伏与短反应引导', () => {
    const d = buildVoiceDirective(900);
    expect(d).toContain('好耶');
    expect(d).toContain('诶？');
    expect(d).toContain('情绪直接说');
  });

  it('颜文字随亲密度放开频率', () => {
    const near = buildVoiceDirective(300);
    const close = buildVoiceDirective(900);
    expect(near).toContain('每 6~8 条');
    expect(close).toContain('每 3~4 条');
    expect(close).toContain('不用 emoji');
  });

  it('按亲密度切换口语化程度', () => {
    expect(buildVoiceDirective(300)).toContain('还不太熟');
    expect(buildVoiceDirective(650)).toContain('挺熟了');
    expect(buildVoiceDirective(900)).toContain('非常亲近');
  });

  it('允许口头语与纯反应式短回复', () => {
    const d = buildVoiceDirective(900);
    expect(d).toContain('就那个啥');
    expect(d).toContain('有时候一句就够');
    expect(d).toContain('笑死');
  });

  it('体积受控：不再是一张 3KB 的教科书清单', () => {
    const bytes = new TextEncoder().encode(buildVoiceDirective(900)).length;
    // 旧版约 3.2KB；新增“大大咧咧/傲娇加码/断句可读”后放宽到 2.6KB
    expect(bytes).toBeLessThan(2600);
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

describe('replyTokenBudget —— 回复预算按对方长度决定', () => {
  it('短消息只给很短额度', () => {
    expect(replyTokenBudget('在吗')).toBe(120);
    expect(replyTokenBudget('嗯')).toBe(120);
  });

  it('随长度分档', () => {
    expect(replyTokenBudget('今天上班累死了不想动')).toBe(300);
    expect(replyTokenBudget('a'.repeat(30))).toBe(600);
    expect(replyTokenBudget('a'.repeat(100))).toBe(1000);
    expect(replyTokenBudget('a'.repeat(200))).toBe(1600);
  });

  it('明确要详细时给足空间', () => {
    expect(replyTokenBudget('详细讲讲这个原理')).toBe(2500);
    expect(replyTokenBudget('一步步教我怎么做')).toBe(2500);
  });

  it('短问句但属于正事，不能被字数压死', () => {
    expect(replyTokenBudget('怎么部署？')).toBe(1200);
    expect(replyTokenBudget('为啥报错')).toBe(1200);
  });

  it('空文本有兜底', () => {
    expect(replyTokenBudget('')).toBe(300);
  });
});

describe('signatureFor —— 口头禅随关系演化', () => {
  it('刚认识时只是普通语气词', () => {
    expect(signatureFor(100).happy).toBe('哈哈');
    expect(signatureFor(100).frustrated).toBe('嗯…');
  });

  it('熟了才出现口头禅', () => {
    expect(signatureFor(500).happy).toBe('嘿嘿');
  });

  it('很亲近后变得更放开', () => {
    expect(signatureFor(900).happy).toBe('哼哼');
    expect(signatureFor(900).frustrated).toBe('啧');
  });
});
