import { describe, expect, it } from 'vitest';
import { resolveHerPlace } from './where';

function fakeEnv(opts: { day?: string | null; trip?: string | null; home?: string | null; city?: string }) {
  return {
    CITY: opts.city ?? '上海',
    KV: {
      async get(key: string): Promise<string | null> {
        if (key === 'life:home-city') return opts.home ?? null;
        if (key === 'life:trip') return opts.trip ?? null;
        return null;
      },
    },
    DB: {
      prepare() {
        return {
          bind() {
            return {
              async first() {
                return opts.day ? { location: opts.day } : null;
              },
            };
          },
        };
      },
    },
  } as never;
}

describe('resolveHerPlace —— 她此刻在哪', () => {
  it('没有日程也没有行程：常住城市', async () => {
    const p = await resolveHerPlace(fakeEnv({ home: '杭州' }), '2026-11-06');
    expect(p).toEqual({ city: '杭州', traveling: false });
  });

  it('今天的日程写了目的地：按目的地算，且标记在外地', async () => {
    const p = await resolveHerPlace(fakeEnv({ home: '杭州', day: '大理' }), '2026-11-06');
    expect(p).toEqual({ city: '大理', traveling: true });
  });

  it('日程还没生成时看行程表', async () => {
    const trip = JSON.stringify({ city: '青岛', start: '2026-11-05', days: 3 });
    const p = await resolveHerPlace(fakeEnv({ home: '杭州', trip }), '2026-11-06');
    expect(p).toEqual({ city: '青岛', traveling: true });
  });

  it('行程已经结束：回家', async () => {
    const trip = JSON.stringify({ city: '青岛', start: '2026-10-01', days: 3 });
    const p = await resolveHerPlace(fakeEnv({ home: '杭州', trip }), '2026-11-06');
    expect(p).toEqual({ city: '杭州', traveling: false });
  });

  it('没有常住城市时回落 env.CITY', async () => {
    const p = await resolveHerPlace(fakeEnv({ city: '上海' }), '2026-11-06');
    expect(p.city).toBe('上海');
  });
});
