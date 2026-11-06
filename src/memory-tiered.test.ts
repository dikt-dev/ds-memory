import { describe, expect, it } from 'vitest';
import { extractTieredMemory } from './memory-tiered';

const NOW = new Date('2026-11-06T15:00:00+08:00');

const MEMORY = [
  '## 人物底色',
  '<!-- 固定，永不删改 -->',
  '',
  '- 名字：小蓝',
  '',
  '## 关于他',
  '- [26-01-01] 职业=上班族',
  '- [26-11-05] 城市=深圳',
  '',
  '## 共同经历',
  '- [26-01-01] 一起看了《可塑性记忆》',
  '- [26-11-05] 一起看了 B 站小克的同人视频',
  '',
  '## 进行中的事',
  '- [26-01-01] [进行中] AstrBot 重构',
  '- [26-02-01] [已完成] 搬家',
  '',
  '## 近期动态',
  '- [26-11-05] 他下班后瘫着',
].join('\n');

describe('tiered 记忆', () => {
  it('稳定事实（关于他/他的偏好）不管多老都常驻', () => {
    const out = extractTieredMemory(MEMORY, { days: 60, now: NOW });
    expect(out.text).toContain('职业=上班族');
    expect(out.text).toContain('城市=深圳');
  });

  it('事件超过窗口就从内联里消失', () => {
    const out = extractTieredMemory(MEMORY, { days: 60, now: NOW });
    expect(out.text).toContain('小克的同人视频');
    expect(out.text).not.toContain('可塑性记忆');
    expect(out.stats.droppedByAge).toBeGreaterThan(0);
  });

  it('进行中的事：[进行中] 留住，[已完成] 按窗口裁', () => {
    const out = extractTieredMemory(MEMORY, { days: 60, now: NOW });
    expect(out.text).toContain('AstrBot 重构');
    expect(out.text).not.toContain('搬家');
  });

  it('无日期的条目一律保留', () => {
    const text = '## 共同经历\n- 一起看过一场雪\n';
    const out = extractTieredMemory(text, { days: 1, now: NOW });
    expect(out.text).toContain('一起看过一场雪');
  });

  it('过滤后为空的分区不输出标题', () => {
    const text = '## 共同经历\n- [26-01-01] 很旧的事\n';
    const out = extractTieredMemory(text, { days: 30, now: NOW });
    expect(out.text).toBe('');
  });

  it('跨年也能正确算窗口', () => {
    const text = '## 共同经历\n- [25-12-30] 跨年前一起倒数\n';
    const out = extractTieredMemory(text, { days: 30, now: new Date('2026-01-05T12:00:00+08:00') });
    expect(out.text).toContain('跨年前一起倒数');
  });

  it('超出预算时从最旧的事件裁，事实不动', () => {
    const lines = ['## 关于他', '- [26-01-01] 职业=上班族', '', '## 共同经历'];
    for (let i = 1; i <= 30; i += 1) lines.push(`- [26-11-0${(i % 5) + 1}] 事件 ${i}`);
    const out = extractTieredMemory(lines.join('\n'), { days: 60, now: NOW, maxBytes: 400 });
    expect(out.text).toContain('职业=上班族');
    expect(out.stats.droppedByBudget).toBeGreaterThan(0);
    expect(out.stats.bytes).toBeLessThanOrEqual(400);
  });

  it('HTML 注释不会进提示词', () => {
    const out = extractTieredMemory(MEMORY, { days: 60, now: NOW });
    expect(out.text).not.toContain('<!--');
  });
});
