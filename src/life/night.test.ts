import { describe, expect, it } from 'vitest';
import { wakesTonight, nightWakeSeed } from './night';

describe('夜里醒来', () => {
  it('同一天结果稳定（否则重启一次就多醒一次）', () => {
    expect(wakesTonight('2026-11-05')).toBe(wakesTonight('2026-11-05'));
    expect(nightWakeSeed('2026-11-05')).toBe(nightWakeSeed('2026-11-05'));
  });

  it('每周大约醒 1–2 次（120 天落在 20–45 天）', () => {
    let woke = 0;
    for (let i = 0; i < 120; i++) {
      const d = new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
      if (wakesTonight(d)) woke++;
    }
    expect(woke).toBeGreaterThanOrEqual(20);
    expect(woke).toBeLessThanOrEqual(45);
  });

  it('相邻两天不会连着醒（避免「夜夜失眠」的观感）', () => {
    const days: string[] = [];
    for (let i = 0; i < 60; i++) days.push(new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10));
    const wokeDays = days.filter(wakesTonight);
    for (let i = 1; i < wokeDays.length; i++) {
      const gap = (Date.parse(wokeDays[i]) - Date.parse(wokeDays[i - 1])) / 86400000;
      expect(gap).toBeGreaterThanOrEqual(2);
    }
  });
});
