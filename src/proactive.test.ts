import { describe, expect, it, vi } from 'vitest';
import {
  PROACTIVE_WINDOWS,
  RANDOM_MAX_PER_DAY,
  RANDOM_MIN_GAP,
  RANDOM_WINDOW,
  beijingMinutes,
  currentSlot,
  deliverProactive,
  randomCountFor,
  randomTargetMinutes,
  sanitizeProactiveText,
  seededRandom01,
  targetMinutesFor,
} from './proactive';

describe('beijingMinutes', () => {
  it('换算北京时间分钟数', () => {
    expect(beijingMinutes(new Date('2026-10-22T00:00:00Z'))).toBe(8 * 60); // 北京 08:00
    expect(beijingMinutes(new Date('2026-10-22T15:00:00Z'))).toBe(23 * 60); // 北京 23:00
    expect(beijingMinutes(new Date('2026-10-22T16:30:00Z'))).toBe(30); // 北京次日 00:30
  });
});

describe('currentSlot', () => {
  it('早间窗口 07:45–08:15', () => {
    expect(currentSlot(7 * 60 + 44)).toBeNull();
    expect(currentSlot(7 * 60 + 45)).toBe('morning');
    expect(currentSlot(8 * 60 + 14)).toBe('morning');
    expect(currentSlot(8 * 60 + 15)).toBe('morning'); // 含 end 的 5 分钟 tick
    expect(currentSlot(8 * 60 + 16)).toBeNull();
  });

  it('深夜窗口 22:45–23:15', () => {
    expect(currentSlot(22 * 60 + 44)).toBeNull();
    expect(currentSlot(22 * 60 + 45)).toBe('evening');
    expect(currentSlot(23 * 60 + 14)).toBe('evening');
    expect(currentSlot(23 * 60 + 15)).toBe('evening'); // 23:12 目标可由 23:15 tick 补发
    expect(currentSlot(23 * 60 + 16)).toBeNull();
  });

  it('白天不在窗口内', () => {
    expect(currentSlot(12 * 60)).toBeNull();
    expect(currentSlot(0)).toBeNull();
  });
});

describe('seededRandom01 / targetMinutesFor', () => {
  it('同种子结果稳定，且落在窗口内', () => {
    for (const slot of ['morning', 'evening'] as const) {
      const a = targetMinutesFor('2026-10-22', slot);
      const b = targetMinutesFor('2026-10-22', slot);
      expect(a).toBe(b);
      const w = PROACTIVE_WINDOWS[slot];
      expect(a).toBeGreaterThanOrEqual(w.start);
      expect(a).toBeLessThan(w.end);
    }
  });

  it('目标时间落在两个 5 分钟 tick 之间时，后一个 tick 仍在窗口内', () => {
    for (const slot of ['morning', 'evening'] as const) {
      for (let d = 1; d <= 31; d++) {
        const target = targetMinutesFor(`2026-12-${String(d).padStart(2, '0')}`, slot);
        const nextTick = Math.ceil(target / 5) * 5;
        expect(nextTick).toBeLessThanOrEqual(PROACTIVE_WINDOWS[slot].end);
        expect(currentSlot(nextTick)).toBe(slot);
      }
    }
    // 2026-10-24 的目标是 23:12：23:10 未到，23:15 必须仍算窗口内
    expect(targetMinutesFor('2026-10-24', 'evening')).toBe(23 * 60 + 12);
    expect(currentSlot(23 * 60 + 15)).toBe('evening');
  });

  it('不同日期产生不同目标时间（浮动）', () => {
    const values = new Set<string>();
    for (let d = 1; d <= 20; d++) {
      values.add(String(targetMinutesFor(`2026-10-${String(d).padStart(2, '0')}`, 'morning')));
    }
    expect(values.size).toBeGreaterThan(5); // 确实有浮动
  });

  it('随机数范围 [0,1)', () => {
    for (let i = 0; i < 20; i++) {
      const r = seededRandom01(`seed-${i}`);
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThan(1);
    }
  });
});

describe('sanitizeProactiveText', () => {
  it('去掉引号与前缀', () => {
    expect(sanitizeProactiveText('“早安，今天记得带伞”')).toBe('早安，今天记得带伞');
    expect(sanitizeProactiveText('消息：今天降温了')).toBe('今天降温了');
  });

  it('长度上限放宽到 500', () => {
    expect(sanitizeProactiveText('a'.repeat(800)).length).toBe(500);
  });
});

describe('纯随机主动聊天', () => {
  it('每天条数在 0~2 之间且分布随机', () => {
    const counts = new Set<number>();
    let zeros = 0;
    let twos = 0;
    for (let d = 1; d <= 60; d++) {
      const dateKey = `2026-${String(1 + Math.floor((d - 1) / 28)).padStart(2, '0')}-${String(((d - 1) % 28) + 1).padStart(2, '0')}`;
      const c = randomCountFor(dateKey);
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(RANDOM_MAX_PER_DAY);
      counts.add(c);
      if (c === 0) zeros++;
      if (c === 2) twos++;
    }
    expect(counts.size).toBe(3); // 0/1/2 都会出现
    expect(zeros).toBeGreaterThan(0); // 确实有"不发"的日子
    expect(twos).toBeGreaterThan(0); // 也确实有"发两条"的日子
  });

  it('同一天结果稳定（cron 多次触发不会变卦）', () => {
    expect(randomCountFor('2026-10-22')).toBe(randomCountFor('2026-10-22'));
    expect(randomTargetMinutes('2026-10-22', 0)).toBe(randomTargetMinutes('2026-10-22', 0));
  });

  it('目标时间落在 09:00–22:30 窗口内', () => {
    for (let d = 1; d <= 20; d++) {
      const dateKey = `2026-10-${String(d).padStart(2, '0')}`;
      for (let i = 0; i < RANDOM_MAX_PER_DAY; i++) {
        const t = randomTargetMinutes(dateKey, i);
        expect(t).toBeGreaterThanOrEqual(RANDOM_WINDOW.start);
        expect(t).toBeLessThanOrEqual(RANDOM_WINDOW.end); // end 表示"放不下，当天不再发"
      }
    }
  });

  it('两条随机消息间隔不小于最小值（放不下则标记为 end）', () => {
    for (let d = 1; d <= 30; d++) {
      const dateKey = `2026-11-${String(d).padStart(2, '0')}`;
      const first = randomTargetMinutes(dateKey, 0);
      const second = randomTargetMinutes(dateKey, 1);
      if (second === RANDOM_WINDOW.end) continue; // 放不下：当天只发一条
      expect(second - first).toBeGreaterThanOrEqual(RANDOM_MIN_GAP);
      expect(second).toBeLessThan(RANDOM_WINDOW.end);
    }
  });

  it('不同日期的时间有足够随机性', () => {
    const times = new Set<number>();
    for (let d = 1; d <= 30; d++) {
      times.add(randomTargetMinutes(`2026-12-${String(d).padStart(2, '0')}`, 0));
    }
    expect(times.size).toBeGreaterThan(20); // 30 天里几乎都不重复
  });
});

describe('deliverProactive —— 单通道 events', () => {
  it('消息先落库，投递直接算 sent（不再入队）', async () => {
    const env = {} as never;
    const r = await deliverProactive(env, '在吗', new Date(), 1413);
    expect(r.ok).toBe(true);
    expect(r.mode).toBe('events');
    expect(r.status).toBe('sent');
  });

  it('没有配置也不再走 AstrBot / 队列（QQ 方案已废弃）', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const env = { ASTRBOT_BASE_URL: 'https://bot.example.com' } as never;
    const r = await deliverProactive(env, '在吗', new Date());
    expect(r.mode).toBe('events');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
