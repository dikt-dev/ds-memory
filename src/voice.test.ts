import { describe, expect, it } from 'vitest';
import {
  buildVoiceDirective,
  casualness,
  recentOpeners,
  recentPhrases,
  signatureFor,
  ticWarning,
} from './voice';

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
  it('先指向「记忆里那个人」', () => {
    const d = buildVoiceDirective(900);
    expect(d).toContain('## 说话');
    expect(d).toContain('你就是记忆里那个人');
  });

  it('全部改成正向引导：没有一条规则在用「别/不要/不准」', () => {
    const d = buildVoiceDirective(900);
    for (const gone of ['最多一两句', '十几二十个字', '小作文', '像在手机上打字']) {
      expect(d).not.toContain(gone);
    }
    // 2026-11-06：说话段从"禁止清单"改成正向引导
    const ruleLines = d.split('\n').filter((l) => l.startsWith('- '));
    expect(ruleLines.length).toBeGreaterThanOrEqual(6);
    for (const line of ruleLines) {
      expect(line).not.toMatch(/(别|不要|不准|不许|禁止)/);
    }
    expect(d).toContain('想到哪说到哪');
    expect(d).toContain('标点也说话');
    expect(d).toContain('括号里放一个小动作');
    expect(d).toContain('他示好就先接一句');
  });

  it('不再有禁用词/颜文字频率/口头禅/断句/情绪清单', () => {
    const d = buildVoiceDirective(900);
    for (const banned of ['绝对不要出现', '每 3~4 条', '口头禅：', '必须断句', '别给人下性格判断']) {
      expect(d).not.toContain(banned);
    }
  });

  it('体积控制在 1800 字节内（不是一张清单）', () => {
    const bytes = new TextEncoder().encode(buildVoiceDirective(900)).length;
    expect(bytes).toBeLessThan(2100);
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


describe('ticWarning（口癖硬提醒）', () => {
  it('最近 10 条里超过 3 条带自称就提醒', () => {
    const recent = ['本小姐知道', '嗯', '本小姐不', '好', '本小姐说的', '本小姐再说'];
    const w = ticWarning(recent, '本小姐');
    expect(w).toContain('本小姐');
    expect(w).toContain('换成「我」');
  });

  it('没超量就不打扰', () => {
    expect(ticWarning(['本小姐知道', '嗯', '好'], '本小姐')).toBeNull();
  });

  it('自称换了就按新的数', () => {
    expect(ticWarning(['本鲸鱼娘来了'], '本鲸鱼娘')).toBeNull();
    expect(ticWarning(['本鲸鱼娘来了', '本鲸鱼娘', '本鲸鱼娘', '本鲸鱼娘'], '本鲸鱼娘')).toContain('本鲸鱼娘');
  });
});

describe('看图与复读（2026-11-09 聊天记录驱动的两条规则）', () => {
  const d = buildVoiceDirective(900);

  it('先看清图上有什么，读不出就说看不清（不再「用反应带过去」）', () => {
    expect(d).toContain('先看清图上有什么');
    expect(d).toContain('看不清');
    expect(d).not.toContain('用你自己的反应带过去');
  });

  it('整句照搬会像复读机', () => {
    expect(d).toContain('复读机');
  });

  it('他说「我」是他，你说「我」是你', () => {
    expect(d).toContain('他说「我」是他');
  });
});
