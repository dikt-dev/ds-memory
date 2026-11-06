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

  it('睡过去了：报时段、要求先怼熬夜再关心、不报时长', () => {
    const morning = new Date('2026-11-06T08:00:00+08:00');
    const night = new Date('2026-11-06T02:00:00+08:00');
    const note = heldWaitNote(6 * 3600_000, '在睡觉', morning, night);
    expect(note).toContain('凌晨两点发来的');
    expect(note).toContain('现在是上午八点');
    expect(note).toContain('刚醒');
    expect(note).toContain('先冲他半夜不睡这件事发火');
    expect(note).toContain('顺序别反');
    // 「六小时前」是她自己发消息才会用的说法，不能出现
    expect(note).not.toContain('6 小时前');
  });

  it('长时间在忙（没睡）：仍然只报时段', () => {
    const morning = new Date('2026-11-06T08:00:00+08:00');
    const night = new Date('2026-11-06T02:00:00+08:00');
    const note = heldWaitNote(6 * 3600_000, '在做饭', morning, night);
    expect(note).toContain('凌晨两点发来的');
    expect(note).toContain('别报"几小时前"这种时长');
  });

  it('短间隔保留「十几分钟前」，那是人话', () => {
    const now = new Date('2026-11-06T08:00:00+08:00');
    const note = heldWaitNote(18 * 60_000, null, now);
    expect(note).toContain('18 分钟前发来的');
    expect(note).not.toContain('别报');
  });

  it('不知道当时在干什么就说没顾上看手机', () => {
    expect(heldWaitNote(2 * 3600_000, null)).toContain('你当时没顾上看手机');
  });
});
