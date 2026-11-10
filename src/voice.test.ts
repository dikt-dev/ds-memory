import { describe, expect, it } from 'vitest';
import {
  actionDensityNote,
  buildVoiceDirective,
  recentActions,
  selfRepeatScore,
  casualness,
  recentOpeners,
  recentPhrases,
  signatureFor,
  ticWarning,
  naggingComplaintNote,
  voiceModeOf,
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
    // 2026-11-09 瘦身：16 条 → 9 条，删掉与 persona.md 重复的那些
    for (const line of ruleLines) {
      expect(line).not.toMatch(/(别|不要|不准|不许|禁止)/);
    }
    expect(d).toContain('标点也说话');
    expect(d).toContain('标点也说话');
    expect(d).toContain('括号里放一个小动作');
    expect(d).toContain('回一句他没说过的');
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
    expect(d).toContain('再说一遍等于没接话');
  });

  it('他说「我」是他，你说「我」是你', () => {
    expect(d).toContain('他说「我」是他');
  });
});

describe('读意图与翻篇（2026-11-09 14:45 那次误读驱动的四条规则）', () => {
  const d = buildVoiceDirective(900);

  it('先判断这句是逗你还是正话', () => {
    expect(d).toContain('先看这句是什么');
    expect(d).toContain('逗你的就顺着逗回去');
  });

  it('被逗了要把球打回去，不是辩解', () => {
    expect(d).toContain('把球打回去');
  });

  it('拿不准就问一句，比猜错强', () => {
    expect(d).toContain('你这是损我还是夸我');
  });

  it('他说是开玩笑，就翻篇，不复盘自责', () => {
    expect(d).toContain('笑一句就翻篇');
  });
});

describe('括号动作疲劳（2026-11-09：67/68、23/23 每条都带动作）', () => {
  const withAction = (n: number) => Array.from({ length: n }, (_, i) => '（尾巴拍了下地板）第' + i + '句');

  it('最近 6 条每条都带括号，就提醒（2026-11-10：改成按比例）', () => {
    expect(actionDensityNote(withAction(6))).toContain('括号动作');
  });

  it('4/6 就提醒（以前要 6/6，实际密度 91% 时等于每轮都响）', () => {
    expect(actionDensityNote([...withAction(4), '就说人话', '好'])).toContain('括号动作');
  });

  it('3/6 不提醒：正常用法不按掉', () => {
    expect(actionDensityNote([...withAction(3), '就说人话', '好', '行'])).toBeNull();
  });

  it('不足 6 条不下结论', () => {
    expect(actionDensityNote(withAction(3))).toBeNull();
  });

  it('空串不算带动作', () => {
    expect(actionDensityNote([...withAction(5), '  '])).toBeNull();
  });
});

describe('重复抑制的两把尺子（2026-11-09）', () => {
  it('recentActions 抽出连用两次以上的括号动作', () => {
    const replies = [
      '（把围巾往上拉了拉）行吧',
      '（把围巾往上拉了拉）谁说要到你身边',
      '（把下巴往围巾里埋了埋）行',
    ];
    const acts = recentActions(replies);
    expect(acts[0]).toContain('围巾');
    expect(acts.length).toBeLessThanOrEqual(3);
  });

  it('selfRepeatScore：逐字复述时接近 1，完全不同时接近 0', () => {
    const same = selfRepeatScore(['今天中午吃砂锅粥还加了双份虾', '今天中午吃砂锅粥还加了双份虾']);
    const diff = selfRepeatScore(['今天吃砂锅粥', '明天下雨记得带伞']);
    expect(same).toBeGreaterThan(0.8);
    expect(diff).toBeLessThan(0.1);
  });
});
describe('说话规则：治绕圈与「不像活人」（2026-11-10）', () => {
  const dir = buildVoiceDirective(500);

  it('不再让她把上一条的状态原地复述', () => {
    expect(dir).not.toContain('顺着它往下说');
    expect(dir).toContain('状态要往前走一格');
  });

  it('同一件事聊够三轮就换个事', () => {
    expect(dir).toContain('三轮');
  });

  it('给长短留余地，不要求每条都写动作', () => {
    expect(dir).toContain('长短由你');
    expect(dir).toContain('不用每条都写');
  });
});

describe('VOICE_MODE 两档（2026-11-10）', () => {
  it('缺省/未知值都是 full，线上行为不变', () => {
    expect(voiceModeOf(undefined)).toBe('full');
    expect(voiceModeOf({})).toBe('full');
    expect(voiceModeOf({ VOICE_MODE: 'whatever' })).toBe('full');
    expect(voiceModeOf({ VOICE_MODE: 'LITE' })).toBe('lite');
  });

  it('lite 档只留物理法则，去掉行为补丁', () => {
    const full = buildVoiceDirective(600, 'full');
    const lite = buildVoiceDirective(600, 'lite');
    expect(lite.length).toBeLessThan(full.length);
    // 留：身份 / 主语归属 / 反绕圈 / 长短
    expect(lite).toContain('你就是记忆里那个人');
    expect(lite).toContain('只有「你」才是你');
    expect(lite).toContain('三轮');
    expect(lite).toContain('长短由你');
    // 去：标点语气课、逗回去的花样、本小姐
    expect(lite).not.toContain('标点也说话');
    expect(lite).not.toContain('本小姐');
  });
});

describe('naggingComplaintNote', () => {
  it('他嫌管太宽时才插一句，并只影响这一轮', () => {
    expect(naggingComplaintNote('你像我妈一样烦')).toContain('认个错');
    expect(naggingComplaintNote('别管我了')).not.toBeNull();
    expect(naggingComplaintNote('今天上班好累')).toBeNull();
    expect(naggingComplaintNote('')).toBeNull();
  });
});
