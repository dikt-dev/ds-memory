import { describe, expect, it } from 'vitest';
import { formatWait, heldWaitNote } from './flush';

describe('压着的消息：告诉 AI 他等了多久', () => {
  it('分钟 / 小时都说人话', () => {
    expect(formatWait(30_000)).toBe('1 分钟');
    expect(formatWait(47 * 60_000)).toBe('47 分钟');
    expect(formatWait(3 * 3600_000)).toBe('3 小时');
    expect(formatWait(3 * 3600_000 + 20 * 60_000)).toBe('3 小时 20 分钟');
  });

  it('写清当时在忙什么，并要求先说一句把空档带出来', () => {
    const note = heldWaitNote(47 * 60_000, '在洗澡');
    expect(note).toContain('47 分钟前发来的');
    expect(note).toContain('你当时在洗澡');
    expect(note).toContain('别把这件事反问回去');
  });

  it('带上「现在几点」：凌晨发的、早上补发时不能说夜里那套', () => {
    const morning = new Date('2026-11-06T08:00:00+08:00');
    const note = heldWaitNote(6 * 3600_000, '在睡觉', morning);
    expect(note).toContain('现在是上午八点');
    expect(note).toContain('不要用他发消息那会儿的时间感');
  });

  it('不知道当时在干什么就说没顾上看手机', () => {
    expect(heldWaitNote(2 * 3600_000, null)).toContain('你当时没顾上看手机');
  });
});
