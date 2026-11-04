import { describe, expect, it } from 'vitest';
import { slimMemoryForPrompt } from './memory-maintenance';

const now = new Date('2026-11-04T12:00:00+08:00');

describe('slimMemoryForPrompt', () => {
  it('空分区不输出，只有内容的才留', () => {
    const md = '# 长期记忆\n\n## 人物底色\n\n## 关于他\n- [2026-11-04] 城市=深圳\n\n## 他的偏好\n';
    const out = slimMemoryForPrompt(md, now);
    expect(out).not.toContain('人物底色');
    expect(out).not.toContain('他的偏好');
    expect(out).toContain('## 关于他');
    expect(out).toContain('城市=深圳');
  });

  it('去掉和提示词标题重复的 H1', () => {
    expect(slimMemoryForPrompt('# 长期记忆\n## 关于他\n- x', now)).not.toContain('# 长期记忆');
  });

  it('日期统一 YY-MM-DD（四位的压成两位，不省略）', () => {
    const out = slimMemoryForPrompt('## 关于他\n- [2026-11-04] A\n- [2025-03-01] B', now);
    expect(out).toContain('[26-11-04] A');
    expect(out).toContain('[25-03-01] B');
  });

  it('全空返空串，交给调用方写「暂无记忆」', () => {
    expect(slimMemoryForPrompt('# 长期记忆\n## 人物底色\n', now)).toBe('');
  });
});

describe('近期动态的时间感', () => {
  it('补上「今天 / 昨天 / N 天前」', () => {
    const md = '## 近期动态\n- [26-11-04] 今天的事\n- [26-11-03] 昨天的事\n- [26-11-01] 三天前的事';
    const out = slimMemoryForPrompt(md, now);
    expect(out).toContain('- [26-11-04]（今天） 今天的事');
    expect(out).toContain('- [26-11-03]（昨天） 昨天的事');
    expect(out).toContain('- [26-11-01]（3 天前） 三天前的事');
  });

  it('别的分区不加年龄，免得每轮都变', () => {
    const out = slimMemoryForPrompt('## 关于他\n- [26-11-01] 城市=深圳', now);
    expect(out).toContain('- [26-11-01] 城市=深圳');
    expect(out).not.toContain('天前');
  });
});
