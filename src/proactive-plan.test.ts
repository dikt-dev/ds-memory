import { describe, expect, it } from 'vitest';
import {
  PLAN_NOTIFY_DEADLINE_MIN,
  PLAN_TOLERANCE_MIN,
  buildPlanSlots,
  fallbackPlanTimes,
  readPlan,
} from './proactive-plan';
import { PROACTIVE_WINDOWS, RANDOM_WINDOW, randomCountFor } from './proactive';
import type { Env } from './types';

/** 在给定区间里找第一个满足条件的日期键（计划是确定性伪随机，必须找到真实样例）。 */
function findDate(predicate: (dateKey: string) => boolean, from = 1, to = 60): string {
  for (let d = from; d <= to; d++) {
    const key = `2026-12-${String(d).padStart(2, '0')}`;
    if (predicate(key)) return key;
  }
  throw new Error('no matching date found');
}

/** 极简 D1 替身：只认 proactive_log 与 runtime_state 两种查询。 */
function fakeEnv(opts: {
  log?: Array<{ slot_key: string; status: string; message_id: number | null }>;
  pausedUntil?: string | null;
  level?: string;
}): Env {
  return {
    PROACTIVE_LEVEL: opts.level ?? 'normal',
    DB: {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => ({
          first: async () => {
            if (sql.includes('runtime_state')) {
              return opts.pausedUntil ? { value: opts.pausedUntil } : null;
            }
            return null;
          },
          all: async () => {
            if (sql.includes('proactive_log')) return { results: opts.log ?? [] };
            return { results: [] };
          },
        }),
      }),
    },
    KV: { get: async () => null },
  } as unknown as Env;
}

describe('buildPlanSlots', () => {
  const dateKey = '2026-12-25';

  it('总是先给出早上与深夜两档，且落在各自窗口内', () => {
    const slots = buildPlanSlots(dateKey);
    const morning = slots.find((s) => s.key === 'morning')!;
    const evening = slots.find((s) => s.key === 'evening')!;

    expect(morning.kind).toBe('morning');
    expect(morning.at_minutes).toBeGreaterThanOrEqual(PROACTIVE_WINDOWS.morning.start);
    expect(morning.at_minutes).toBeLessThanOrEqual(PROACTIVE_WINDOWS.morning.end);

    expect(evening.at_minutes).toBeGreaterThanOrEqual(PROACTIVE_WINDOWS.evening.start);
    expect(evening.at_minutes).toBeLessThanOrEqual(PROACTIVE_WINDOWS.evening.end);
  });

  it('按时间升序排列（客户端按顺序设闹钟）', () => {
    const minutes = buildPlanSlots(dateKey).map((s) => s.at_minutes);
    expect(minutes).toEqual([...minutes].sort((a, b) => a - b));
  });

  it('随机档数量与 randomCountFor 一致', () => {
    const zero = findDate((k) => randomCountFor(k) === 0);
    expect(buildPlanSlots(zero)).toHaveLength(2);
    expect(buildPlanSlots(zero).some((s) => s.kind === 'random')).toBe(false);

    const one = findDate((k) => randomCountFor(k) === 1);
    expect(buildPlanSlots(one)).toHaveLength(3);

    const two = findDate((k) => randomCountFor(k) === 2);
    expect(buildPlanSlots(two)).toHaveLength(4);
  });

  it('随机档落在 09:00-22:30 内，第二条与第一条至少隔 90 分钟', () => {
    const two = findDate((k) => randomCountFor(k) === 2);
    const randoms = buildPlanSlots(two).filter((s) => s.kind === 'random');
    for (const s of randoms) {
      expect(s.at_minutes).toBeGreaterThanOrEqual(RANDOM_WINDOW.start);
      expect(s.at_minutes).toBeLessThan(RANDOM_WINDOW.end);
    }
    if (randoms.length === 2) {
      const gap = randoms[1].at_minutes - randoms[0].at_minutes;
      expect(gap).toBeGreaterThanOrEqual(90);
    }
  });

  it('同一天多次调用结果一致（客户端可以重复拉）', () => {
    expect(buildPlanSlots(dateKey)).toEqual(buildPlanSlots(dateKey));
  });
});

describe('readPlan', () => {
  it('未生成过的档 generated=false', async () => {
    const plan = await readPlan(fakeEnv({}), new Date('2026-12-25T12:00:00+08:00'), '2026-12-25');
    expect(plan.date).toBe('2026-12-25');
    expect(plan.slots.every((s) => s.generated === false && s.status === null)).toBe(true);
  });

  it('proactive_log 里有的档带上状态与 message_id', async () => {
    const plan = await readPlan(
      fakeEnv({ log: [{ slot_key: 'morning', status: 'sent', message_id: 8123 }] }),
      new Date('2026-12-25T12:00:00+08:00'),
      '2026-12-25',
    );
    const morning = plan.slots.find((s) => s.key === 'morning')!;
    expect(morning.generated).toBe(true);
    expect(morning.status).toBe('sent');
    expect(morning.message_id).toBe(8123);

    const evening = plan.slots.find((s) => s.key === 'evening')!;
    expect(evening.generated).toBe(false);
  });

  it('at 是 HH:MM 且与 at_minutes 对得上', async () => {
    const plan = await readPlan(fakeEnv({}), new Date('2026-12-25T12:00:00+08:00'), '2026-12-25');
    for (const s of plan.slots) {
      const [h, m] = s.at.split(':').map(Number);
      expect(h * 60 + m).toBe(s.at_minutes);
    }
  });

  it('暂停时间未到 → paused=true', async () => {
    const plan = await readPlan(
      fakeEnv({ pausedUntil: '2026-12-25T20:00:00+08:00' }),
      new Date('2026-12-25T12:00:00+08:00'),
      '2026-12-25',
    );
    expect(plan.paused).toBe(true);
  });

  it('暂停时间已过 / 没暂停 → paused=false', async () => {
    const past = await readPlan(
      fakeEnv({ pausedUntil: '2026-12-25T08:00:00+08:00' }),
      new Date('2026-12-25T12:00:00+08:00'),
      '2026-12-25',
    );
    expect(past.paused).toBe(false);
    expect(past.paused_until).toBe('2026-12-25T08:00:00+08:00');

    const none = await readPlan(fakeEnv({}), new Date('2026-12-25T12:00:00+08:00'), '2026-12-25');
    expect(none.paused).toBe(false);
    expect(none.paused_until).toBeNull();
  });

  it('带上客户端需要的容差常量', async () => {
    const plan = await readPlan(fakeEnv({}), new Date('2026-12-25T12:00:00+08:00'), '2026-12-25');
    expect(plan.tolerance_min).toBe(PLAN_TOLERANCE_MIN);
    expect(plan.notify_deadline_min).toBe(PLAN_NOTIFY_DEADLINE_MIN);
    expect(plan.level).toBe('normal');
  });

  it('proactive_log 查询失败时降级为空（不抛错）', async () => {
    const env = {
      PROACTIVE_LEVEL: 'normal',
      DB: {
        prepare: () => ({
          bind: () => ({
            first: async () => null,
            all: async () => {
              throw new Error('no such table');
            },
          }),
        }),
      },
      KV: { get: async () => null },
    } as unknown as Env;
    const plan = await readPlan(env, new Date('2026-12-25T12:00:00+08:00'), '2026-12-25');
    expect(plan.slots.length).toBeGreaterThanOrEqual(2);
    expect(plan.slots.every((s) => s.generated === false)).toBe(true);
  });
});

describe('fallbackPlanTimes', () => {
  it('给两个固定时段且落在窗口内（计划接口挂了也能提醒）', () => {
    const fb = fallbackPlanTimes();
    expect(fb.map((f) => f.kind)).toEqual(['morning', 'evening']);
    for (const f of fb) {
      const [h, m] = f.at.split(':').map(Number);
      const minutes = h * 60 + m;
      const w = f.kind === 'morning' ? PROACTIVE_WINDOWS.morning : PROACTIVE_WINDOWS.evening;
      expect(minutes).toBeGreaterThanOrEqual(w.start);
      expect(minutes).toBeLessThanOrEqual(w.end);
    }
  });
});
