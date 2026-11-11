import { describe, expect, it } from 'vitest';
import { findBiliUrl, formatBiliMeta } from './bili';

describe('findBiliUrl', () => {
  it('从分享文案里挑出规范链接', () => {
    expect(findBiliUrl('看看这个 https://www.bilibili.com/video/BV1xx411c7mD?spm_id_from=333.999 笑死')).toBe(
      'https://www.bilibili.com/video/BV1xx411c7mD',
    );
  });
  it('短链认（2026-11-10 起），非视频页仍不认', () => {
    // 分享出来的一般都是 b23.tv 短链，原来一个都补不上元数据
    expect(findBiliUrl('【分享】 https://b23.tv/FujQAYf 看看这个')).toBe('https://b23.tv/FujQAYf');
    expect(findBiliUrl('https://space.bilibili.com/123')).toBe(null);
  });
});

describe('formatBiliMeta', () => {
  const meta = {
    title: '测试标题',
    owner: '某UP',
    duration: 194,
    cover: 'https://i2.hdslb.com/x.jpg',
    desc: '一段简介',
    bvid: 'BV1xx411c7mD',
  };

  it('渲染出来的块网页/App 的解析器都认得', () => {
    const text = formatBiliMeta(meta, 'https://www.bilibili.com/video/BV1xx411c7mD');
    expect(text.startsWith('[BILI_META]')).toBe(true);
    expect(text.endsWith('[/BILI_META]')).toBe(true);
    expect(text).toContain('- 标题：测试标题');
    expect(text).toContain('- UP主：某UP');
    expect(text).toContain('- 时长：3:14');
    expect(text).toContain('- 封面：https://i2.hdslb.com/x.jpg');
    expect(text).toContain('一段简介');
  });

  it('没有封面/简介也不出现空行占位', () => {
    const text = formatBiliMeta({ ...meta, cover: '', desc: '', duration: 0 }, 'https://www.bilibili.com/video/BV1xx411c7mD');
    expect(text).not.toContain('- 封面：');
    expect(text).not.toContain('- 时长：');
    expect(text).toContain('（未获取到官方摘要）');
  });
});
