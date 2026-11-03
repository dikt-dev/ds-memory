import { describe, expect, it } from 'vitest';
import { untilMs } from './gate';

/**
 * 闸门的「到点回」时间必须按北京时间算。
 *
 * 线上踩过一次：Worker 跑在 UTC，setHours(8) 得到的是 UTC 08:00 = 北京 16:00，
 * 于是「睡到早上」变成「睡到下午四点」，用户第二天早上一直等不到回复。
 */
describe('untilMs：HH:MM 按北京时间解释', () => {
  const BJ = 8 * 3600_000;

  it('北京凌晨 1:21 发的消息，压到当天早上 08:00（北京）', () => {
    const now = new Date('2026-11-02T17:21:00Z'); // 北京 2026-11-03 01:21
    const target = untilMs(now, '08:00');
    expect(new Date(target + BJ).toISOString()).toBe('2026-11-03T08:00:00.000Z');
    expect(target - now.getTime()).toBe(6 * 3600_000 + 39 * 60_000);
  });

  it('已经过了 08:00 就排到明天早上', () => {
    const now = new Date('2026-11-03T01:00:00Z'); // 北京 09:00
    const target = untilMs(now, '08:00');
    expect(new Date(target + BJ).toISOString()).toBe('2026-11-04T08:00:00.000Z');
  });

  it('忙到 21:30 这种「今天晚些时候」也按北京时间落到当天', () => {
    const now = new Date('2026-11-03T04:00:00Z'); // 北京 12:00
    const target = untilMs(now, '21:30');
    expect(new Date(target + BJ).toISOString()).toBe('2026-11-03T21:30:00.000Z');
  });
});
