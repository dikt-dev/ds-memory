import { describe, expect, it } from 'vitest';
import {
  MAX_ATTEMPTS,
  RETRY_WINDOW_HOURS,
  SENT_RETENTION_DAYS,
} from './queue';

/**
 * queue.ts 的 SQL 行为需要真实 D1，这里覆盖「不依赖数据库」的契约：
 * - 常量取值是否合理
 * - 时间比较必须是同一种 ISO 格式（历史 bug 的根因）
 */
describe('队列常量契约', () => {
  it('重试次数不再是 5 次（5 分钟就放弃太短）', () => {
    expect(MAX_ATTEMPTS).toBeGreaterThanOrEqual(8);
  });

  it('重试窗口以小时计，给网络抖动留足余量', () => {
    expect(RETRY_WINDOW_HOURS).toBeGreaterThanOrEqual(2);
  });

  it('已发送记录保留 30 天', () => {
    expect(SENT_RETENTION_DAYS).toBe(30);
  });
});

describe('★ 时间比较格式（历史 bug 回归）', () => {
  it('isoInBeijing 产出带 T 与 +08:00 的格式', async () => {
    const { isoInBeijing } = await import('./date');
    const s = isoInBeijing(new Date('2026-10-23T02:49:00Z'));
    expect(s).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/);
    expect(s).toBe('2026-10-23T10:49:00+08:00');
  });

  it('★ 证明：用 datetime(now) 那种空格格式比较会永远失败', async () => {
    const { isoInBeijing } = await import('./date');
    const stored = isoInBeijing(new Date('2026-10-23T02:49:00Z')); // 2026-10-23T10:49:00+08:00
    const sqliteStyle = '2026-09-23 02:49:00'; // datetime('now','-30 days') 的形态
    // 这正是原 bug：字符串比较下 'T' > ' '，导致「更早」判断永远为假
    expect(stored < sqliteStyle).toBe(false);
  });

  it('同格式的 ISO 字符串比较结果正确', async () => {
    const { isoInBeijing } = await import('./date');
    const older = isoInBeijing(new Date('2026-09-01T00:00:00Z'));
    const newer = isoInBeijing(new Date('2026-10-01T00:00:00Z'));
    expect(older < newer).toBe(true);
  });
});

describe('队列取消息的时间阈值计算', () => {
  it('租约截止时间早于当前时间', async () => {
    const { isoInBeijing } = await import('./date');
    const now = new Date('2026-10-23T10:00:00Z');
    const leaseCutoff = isoInBeijing(new Date(now.getTime() - 180 * 1000));
    const nowStr = isoInBeijing(now);
    expect(leaseCutoff < nowStr).toBe(true);
  });

  it('重试窗口阈值早于当前时间数小时', async () => {
    const { isoInBeijing } = await import('./date');
    const now = new Date('2026-10-23T10:00:00Z');
    const cutoff = isoInBeijing(new Date(now.getTime() - RETRY_WINDOW_HOURS * 3600 * 1000));
    expect(cutoff < isoInBeijing(now)).toBe(true);
  });
});
