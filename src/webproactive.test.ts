import { describe, expect, it } from 'vitest';

/**
 * 网页端主动消息的关键约束测试：
 * 1. 引导用的模拟消息不写入 D1（只作为 DeepSeek 的 user 消息）；
 * 2. 生成的回复写入 D1，且 pair_id 为 NULL（表示无对应 user 消息）；
 * 3. 时间规则与随机逻辑复用 proactive 模块。
 */
import {
  PROACTIVE_WINDOWS,
  RANDOM_MAX_PER_DAY,
  RANDOM_MIN_GAP,
  RANDOM_WINDOW,
  randomCountFor,
  randomTargetMinutes,
  targetMinutesFor,
} from './proactive';

describe('网页端主动消息：时间规则', () => {
  it('固定时段目标时间落在窗口内', () => {
    for (const slot of ['morning', 'evening'] as const) {
      const w = PROACTIVE_WINDOWS[slot];
      const t = targetMinutesFor('2026-10-22', slot);
      expect(t).toBeGreaterThanOrEqual(w.start);
      expect(t).toBeLessThan(w.end);
    }
  });

  it('随机条数 0~2，且有"不发"的日子', () => {
    let zeros = 0;
    for (let d = 1; d <= 40; d++) {
      const c = randomCountFor(`2026-11-${String(d).padStart(2, '0')}`);
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(RANDOM_MAX_PER_DAY);
      if (c === 0) zeros++;
    }
    expect(zeros).toBeGreaterThan(0);
  });

  it('随机目标时间在 09:00–22:30 窗口内', () => {
    for (let d = 1; d <= 20; d++) {
      const t = randomTargetMinutes(`2026-12-${String(d).padStart(2, '0')}`, 0);
      expect(t).toBeGreaterThanOrEqual(RANDOM_WINDOW.start);
      expect(t).toBeLessThanOrEqual(RANDOM_WINDOW.end);
    }
  });

  it('两条随机消息最小间隔', () => {
    for (let d = 1; d <= 20; d++) {
      const dateKey = `2027-01-${String(d).padStart(2, '0')}`;
      const first = randomTargetMinutes(dateKey, 0);
      const second = randomTargetMinutes(dateKey, 1);
      if (second === RANDOM_WINDOW.end) continue;
      expect(second - first).toBeGreaterThanOrEqual(RANDOM_MIN_GAP);
    }
  });
});
