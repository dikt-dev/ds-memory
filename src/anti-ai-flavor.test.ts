import { describe, expect, it } from 'vitest';
import { scrubAiFlavor } from './anti-ai-flavor';

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
});