import { describe, expect, it } from 'vitest';
import { createStreamScrubber, isMeaninglessResidue, scrubAiFlavor } from './anti-ai-flavor';

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

  it('中文标点后面的半角空格会被吃掉', () => {
    expect(scrubAiFlavor('摆着看的。 不过也挺好').text).toBe('摆着看的。不过也挺好');
    expect(scrubAiFlavor('嗯， 好吧').text).toBe('嗯，好吧');
  });
});
