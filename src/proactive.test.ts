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
    expect(currentSlot(8 * 60 + 15)).toBeNull();
  });

  it('深夜窗口 22:45–23:15', () => {
    expect(currentSlot(22 * 60 + 44)).toBeNull();
    expect(currentSlot(22 * 60 + 45)).toBe('evening');
    expect(currentSlot(23 * 60 + 14)).toBe('evening');
    expect(currentSlot(23 * 60 + 15)).toBeNull();
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

  it('限制长度 200', () => {
    expect(sanitizeProactiveText('a'.repeat(300)).length).toBe(200);
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

describe('deliverProactive —— 投递状态语义', () => {
  it('★ 队列模式不能报成 sent（入队 ≠ 送达）', async () => {
    const env = {
      ASTRBOT_BASE_URL: '',
      ASTROBOT_OPENAPI_KEY: '',
      ASTRBOT_UMO: '',
      DB: {
        prepare: () => ({
          bind: () => ({ first: async () => ({ id: 42 }) }),
        }),
      },
    } as never;
    const r = await deliverProactive(env, '在吗', new Date());
    expect(r.mode).toBe('queue');
    expect(r.ok).toBe(true);
    expect(r.status).toBe('queued');
    expect(r.status).not.toBe('sent');
  });

  it('入队拿不到 id → failed', async () => {
    const env = {
      ASTRBOT_BASE_URL: '',
      ASTROBOT_OPENAPI_KEY: '',
      ASTRBOT_UMO: '',
      DB: { prepare: () => ({ bind: () => ({ first: async () => null }) }) },
    } as never;
    const r = await deliverProactive(env, '在吗', new Date());
    expect(r.ok).toBe(false);
    expect(r.status).toBe('failed');
  });

  it('入队抛异常 → failed（不让异常冒到调用方）', async () => {
    const env = {
      ASTRBOT_BASE_URL: '',
      ASTROBOT_OPENAPI_KEY: '',
      ASTRBOT_UMO: '',
      DB: {
        prepare: () => {
          throw new Error('D1 down');
        },
      },
    } as never;
    const r = await deliverProactive(env, '在吗', new Date());
    expect(r.ok).toBe(false);
    expect(r.status).toBe('failed');
  });

  it('★ 直连：三个配置齐全才走直连（ASTROBOT_UMO 拼写 bug 回归）', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    const env = {
      ASTRBOT_BASE_URL: 'https://bot.example.com',
      ASTROBOT_OPENAPI_KEY: 'k',
      ASTRBOT_UMO: 'aiocqhttp:FriendMessage:1',
    } as never;
    const r = await deliverProactive(env, '在吗', new Date());
    expect(r.mode).toBe('direct');
    expect(r.status).toBe('sent');
    expect(fetchSpy).toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('直连返回非 2xx → failed', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('boom', { status: 500 }));
    const env = {
      ASTRBOT_BASE_URL: 'https://bot.example.com',
      ASTROBOT_OPENAPI_KEY: 'k',
      ASTRBOT_UMO: 'aiocqhttp:FriendMessage:1',
    } as never;
    const r = await deliverProactive(env, '在吗', new Date());
    expect(r.mode).toBe('direct');
    expect(r.status).toBe('failed');
    fetchSpy.mockRestore();
  });

  it('缺少 UMO 时不走直连（避免发不出去）', async () => {
    const env = {
      ASTRBOT_BASE_URL: 'https://bot.example.com',
      ASTROBOT_OPENAPI_KEY: 'k',
      ASTRBOT_UMO: '',
      DB: { prepare: () => ({ bind: () => ({ first: async () => ({ id: 1 }) }) }) },
    } as never;
    const r = await deliverProactive(env, '在吗', new Date());
    expect(r.mode).toBe('queue');
  });
});
