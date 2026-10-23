import { describe, expect, it } from 'vitest';
import { mergeActiveDays, type ActiveDaysState } from './relation-store';

const empty: ActiveDaysState = { days: 0, lastDate: null };

describe('mergeActiveDays —— 历史累计天数只增不减', () => {
  it('首次归档一个新日期 → 从 0 变 1', () => {
    const r = mergeActiveDays(empty, 0, '2026-10-22');
    expect(r.effective).toBe(1);
    expect(r.state.days).toBe(1);
    expect(r.state.lastDate).toBe('2026-10-22');
    expect(r.advanced).toBe(true);
  });

  it('★ 核心修复：D1 被清理后，历史值仍然保留', () => {
    // 曾经聊过 365 天，历史记录下来了
    const stored: ActiveDaysState = { days: 365, lastDate: '2026-10-22' };
    // 月度归档删了 3 个月前数据，D1 只剩 90 天
    const r = mergeActiveDays(stored, 90, '2026-10-23');
    // 不能倒退到 90，应当基于 365 继续
    expect(r.effective).toBe(366);
    expect(r.state.days).toBe(366);
  });

  it('D1 反而更多时（历史丢失自愈）取 D1 的值', () => {
    const stored: ActiveDaysState = { days: 10, lastDate: '2026-09-01' };
    const r = mergeActiveDays(stored, 120, '2026-10-23');
    expect(r.effective).toBe(121); // 取 max(10,120)=120 再加新日期
  });

  it('同一天重复归档不重复计数', () => {
    const stored: ActiveDaysState = { days: 50, lastDate: '2026-10-22' };
    const r = mergeActiveDays(stored, 50, '2026-10-22');
    expect(r.effective).toBe(50);
    expect(r.advanced).toBe(false);
  });

  it('补跑旧日期不计数（单调性保护）', () => {
    const stored: ActiveDaysState = { days: 50, lastDate: '2026-10-22' };
    const r = mergeActiveDays(stored, 40, '2026-10-01');
    expect(r.effective).toBe(50);
    expect(r.advanced).toBe(false);
  });

  it('effective 至少为 1（避免第 0 天上限等于初始值）', () => {
    const r = mergeActiveDays(empty, 0, '');
    expect(r.effective).toBeGreaterThanOrEqual(1);
  });
});
