import { describe, expect, it } from 'vitest';
import { createStreamScrubber, fixParticlePunctuation, isMeaninglessResidue, limitStageDirections, scrubAiFlavor, stripLeadingStageDirection, stripLeadingTimeLabels } from './anti-ai-flavor';

describe('scrubAiFlavor —— AI 味兜底清洗', () => {
  it('删除客服套话', () => {
    const r = scrubAiFlavor('很高兴帮助你，请问还有什么需要帮忙的吗？');
    expect(r.text).not.toContain('很高兴帮助你');
    expect(r.text).not.toContain('请问还有什么需要');
  });

  it('删除元话术（根据我的记忆）', () => {
    const r = scrubAiFlavor('根据我的记忆，你喜欢蓝色。');
    expect(r.text).not.toContain('根据我的记忆');
    expect(r.text).toContain('你喜欢蓝色');
  });

  it('把"您"换成"你"', () => {
    const r = scrubAiFlavor('您好，您的意思我明白了');
    expect(r.text).not.toContain('您');
    expect(r.text).toContain('你好');
  });

  it('删除"作为一个AI"自曝', () => {
    const r = scrubAiFlavor('作为一个AI，我不能这样做。');
    expect(r.text).not.toContain('作为一个');
  });

  it('不误伤正常内容', () => {
    const r = scrubAiFlavor('我觉得这个方案不错，总结一下就是省事。');
    // "总结一下"前面没有"让我"，不应被误删
    expect(r.text).toContain('总结一下');
  });

  it('幂等：反复清洗结果稳定', () => {
    const once = scrubAiFlavor('您好，很高兴帮助您');
    const twice = scrubAiFlavor(once.text);
    expect(twice.text).toBe(once.text);
  });

  it('cleaned 标志准确', () => {
    expect(scrubAiFlavor('正常的一句话').cleaned).toBe(false);
    expect(scrubAiFlavor('您好').cleaned).toBe(true);
  });

  it('清理删除后的标点残留', () => {
    const r = scrubAiFlavor('根据我的记忆，你喜欢蓝色');
    // 删除"根据我的记忆"后，句首不应残留逗号
    expect(r.text.startsWith('，')).toBe(false);
    expect(r.text.startsWith(',')).toBe(false);
  });

  it('★ 清洗后只剩标点的空壳 → 返回空串（不落库）', () => {
    // 这些都曾会残留「？」「！」「！吗？」并被当成有效回复存进去
    expect(scrubAiFlavor('请问还有什么需要？').text).toBe('');
    expect(scrubAiFlavor('希望我的回答对你有帮助！').text).toBe('');
    expect(scrubAiFlavor('很高兴帮助你！请问还有什么需要吗？').text.trim().replace(/[？?！!吗]/g, '')).toBe('');
  });

  it('正常内容不受空壳判断影响', () => {
    const r = scrubAiFlavor('根据我的记忆，你昨天说过要去爬山。');
    expect(r.text).toBe('你昨天说过要去爬山。');
    expect(r.text.length).toBeGreaterThan(0);
  });

  it('只有标点的输入也归空', () => {
    expect(scrubAiFlavor('。。。').text).toBe('');
    expect(scrubAiFlavor('  ！？  ').text).toBe('');
  });
});

describe('isMeaninglessResidue', () => {
  it('只有标点/空白/零宽字符视为无意义', () => {
    expect(isMeaninglessResidue('？')).toBe(true);
    expect(isMeaninglessResidue('！吗？')).toBe(true); // 孤立语气助词，属于清扫残留
    expect(isMeaninglessResidue('。。。')).toBe(true);
    expect(isMeaninglessResidue('   ')).toBe(true);
    expect(isMeaninglessResidue('\u200b')).toBe(true);
  });

  it('有实质内容则不是空壳', () => {
    expect(isMeaninglessResidue('你好')).toBe(false);
    expect(isMeaninglessResidue('嗯')).toBe(false);
    expect(isMeaninglessResidue('好的！')).toBe(false);
  });

  it('★ 不能误杀正常短回应（叠词/口语）', () => {
    for (const s of ['嗯嗯', '哈哈', '嘿嘿', '好嘞', '懂了', '好哒', '嗯呢', '在呢']) {
      expect(isMeaninglessResidue(s)).toBe(false);
    }
  });
});
describe('createStreamScrubber —— 流式清洗', () => {
  it('跨 chunk 的套话也能被完整拦下', () => {
    const s = createStreamScrubber();
    let out = '';
    // 「很高兴为您服务」被拆成三段推送
    out += s.push('你好啊，很高兴');
    out += s.push('为您服务');
    out += s.push('，今天过得怎么样');
    out += s.flush();
    expect(out).not.toContain('很高兴');
    expect(out).toContain('你好啊');
    expect(out).toContain('今天过得怎么样');
  });

  it('「您」在流里也实时换成「你」', () => {
    const s = createStreamScrubber();
    let out = s.push('您今天怎么样呢，要不要聊聊');
    out += s.flush();
    expect(out).not.toContain('您');
    expect(out).toContain('你');
  });

  it('未命中规则的内容原样输出（不吞字）', () => {
    const s = createStreamScrubber();
    const text = '今天深圳二十六度，挺晒的，出门记得带伞哦';
    let out = '';
    for (const ch of text) out += s.push(ch);
    out += s.flush();
    expect(out).toBe(text);
  });

  it('markdown 标题/加粗会被清掉', () => {
    expect(scrubAiFlavor('### 结论\n**这个**可以').text).not.toContain('###');
    expect(scrubAiFlavor('### 结论\n**这个**可以').text).toContain('结论');
    expect(scrubAiFlavor('**这个**可以').text).toBe('这个可以');
  });

  it('清掉模型模仿的历史时间标签', () => {
    expect(stripLeadingTimeLabels('[10-2808:57]正文')).toBe('正文');
    expect(stripLeadingTimeLabels('[10-28 08:57] 正文')).toBe('正文');
  // 第二段开头也会带标签（按行拆气泡时，只剥整段开头会漏）
  expect(stripLeadingTimeLabels('先说一句。\n[11-03 10:15] 再说一句。')).toBe(
    '先说一句。\n再说一句。',
  );
  // 也见过夹在句子中间的（拆气泡后第二段开头就带着它）
  expect(stripLeadingTimeLabels('挺得意的。[11-03 10:15] 后面那个果子')).toBe(
    '挺得意的。后面那个果子',
  );
    expect(scrubAiFlavor('[10-2808:57]晚安').text).toBe('晚安');
  });

  it('流式首帧跨 chunk 的时间标签也能清掉', () => {
    const scrubber = createStreamScrubber(8);
    const out = [
      scrubber.push('[10-28'),
      scrubber.push('17:08]你'),
      scrubber.push('好呀，今天也辛苦了。'),
      scrubber.flush(),
    ].join('');
    expect(out).not.toContain('[10-28');
    expect(out).toContain('你好呀');
  });

  it('首个 delta 是空串时，后面的时间标签也要清掉（线上真实情况）', () => {
    const scrubber = createStreamScrubber(8);
    const out = [
      scrubber.push(''),
      scrubber.push('[10-30 21:36] （先是一怔，然后慢慢抬起眼）哦——原来是这样啊。'),
    ].join('');
    const tail = scrubber.flush();
    expect(out + tail).not.toContain('10-30');
    expect(out + tail).toContain('（先是一怔');
  });

  it('全角方括号的时间标签同样清掉', () => {
    const scrubber = createStreamScrubber(8);
    const out = scrubber.push('［10-30 21:36］今天好累啊') + scrubber.flush();
    expect(out).not.toContain('21:36');
    expect(out).toContain('今天好累啊');
  });

  it('中文标点后面的半角空格会被吃掉', () => {
    expect(scrubAiFlavor('摆着看的。 不过也挺好').text).toBe('摆着看的。不过也挺好');
    expect(scrubAiFlavor('嗯， 好吧').text).toBe('嗯，好吧');
  });
});

describe('stripLeadingStageDirection（去掉句首动作）', () => {
  it('句首括号删掉，句中保留', () => {
    expect(stripLeadingStageDirection('（顿了顿）行吧。')).toBe('行吧。');
    expect(stripLeadingStageDirection('（把碗一推）不吃了。')).toBe('不吃了。');
    expect(stripLeadingStageDirection('行吧（顿了顿）你说。')).toBe('行吧（顿了顿）你说。');
  });

  it('整句都是动作时不删（不能变成空消息）', () => {
    expect(stripLeadingStageDirection('（笑）')).toBe('（笑）');
  });
});

describe('fixParticlePunctuation（语气词后补逗号）', () => {
  it('把挤在一起的语气词和句子断开', () => {
    expect(fixParticlePunctuation('嗯挑着呢')).toBe('嗯，挑着呢');
    expect(fixParticlePunctuation('在超市呢拎着篮子')).toBe('在超市呢，拎着篮子');
    expect(fixParticlePunctuation('哦，那鸡蛋我自己看吧')).toBe('哦，那鸡蛋我自己看吧');
    expect(fixParticlePunctuation('哼上班才想起我')).toBe('哼，上班才想起我');
  });

  it('句子中间漏掉的逗号也补（啊/呀/呢/吧/嘛）', () => {
    expect(fixParticlePunctuation('你倒是会问番茄炒蛋加饭啊不是刚定的嘛')).toBe(
      '你倒是会问番茄炒蛋加饭啊，不是刚定的嘛',
    );
    expect(fixParticlePunctuation('你在干嘛呢我这边刚忙完')).toBe('你在干嘛呢，我这边刚忙完');
  });

  it('叠词和已经有标点的地方不动', () => {
    expect(fixParticlePunctuation('嗯嗯，知道了')).toBe('嗯嗯，知道了');
    expect(fixParticlePunctuation('好啊，那就这样')).toBe('好啊，那就这样');
  });
});

describe('limitStageDirections（舞台指示限流）', () => {
  it('语气说明直接去掉', () => {
    const out = limitStageDirections('行吧本小姐不问了（语气软下来，尾音带着点懒）你早点睡。');
    expect(out).not.toContain('尾音');
    expect(out).toContain('行吧本小姐不问了');
    expect(out).toContain('你早点睡。');
  });

  it('动作括号默认只留一个', () => {
    const out = limitStageDirections('（歪头）（抱枕一搂）（顿了一下）说完了。');
    expect((out.match(/[（(]/g) ?? []).length).toBe(1);
    expect(out).toContain('说完了。');
  });

  it('不超量时原样返回', () => {
    const say = '（笑）行啊，那就这么定了。';
    expect(limitStageDirections(say)).toBe(say);
  });

  it('删完不留重复标点', () => {
    const out = limitStageDirections('嗯（语气轻快））就这样，好。');
    expect(out).not.toMatch(/，\s*，/);
  });
});

describe('报幕句清洗（从提示词搬到后处理）', () => {
  it('去掉「不过先说正事」这类元叙述，保留正文', () => {
    const r = scrubAiFlavor('不过先说正事：分层预算那笔账，你心里有数没？');
    expect(r.text).not.toContain('先说正事');
    expect(r.text).toContain('分层预算那笔账');
  });

  it('去掉「对了，还有件事」', () => {
    const r = scrubAiFlavor('对了，还有件事，明天奶茶记得。');
    expect(r.text).not.toContain('还有件事');
    expect(r.text).toContain('明天奶茶记得');
  });

  it('正常的「不过」不误伤', () => {
    const r = scrubAiFlavor('不过我还是觉得，你这个想法有点冒险。');
    expect(r.text).toContain('不过我还是觉得');
  });
});
