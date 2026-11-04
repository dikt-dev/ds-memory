import { describe, expect, it } from 'vitest';
import { lifePromptLine } from './now-text';

function fakeEnv(opts: { day: unknown; acts: unknown[] }) {
  return {
    DB: {
      prepare(sql: string) {
        const api = {
          bind: () => api,
          first: async () => (sql.includes('ai_day') ? opts.day : null),
          all: async () => ({ results: sql.includes('ai_activity') ? opts.acts : [] }),
          run: async () => ({ success: true }),
        };
        return api;
      },
    },
  } as never;
}

const NOW = new Date('2026-11-02T14:20:00+08:00');

describe('她此刻的状态（喂给提示词）', () => {
  it('没有当天日程就返回 null（聊天行为不变）', async () => {
    expect(await lifePromptLine(fakeEnv({ day: null, acts: [] }), NOW)).toBeNull();
  });

  it('给出现在在做什么，但不用「日程」口吻', async () => {
    const env = fakeEnv({
      day: { recipe: null, health: 100, weather: 'rain', temp_c: 15, location: '北京' },
      acts: [{ unit_id: 'short_trip_movie', kind: 'short_trip', title: '看电影', start_min: 800, end_min: 935, interruptible: 1 }],
    });
    const line = (await lifePromptLine(env, NOW))!;
    expect(line).toContain('看电影');
    expect(line).toContain('北京');
    // 天气只在「当前时间与环境」出现一次，状态块不再重复
    // 只有那句禁令里会出现「日程」二字，正文不能有
    expect(line.split('\n').slice(1).join('\n')).not.toContain('日程');
  });

  it('正在做的事能不能被打断，要说给她听', async () => {
    const busy = fakeEnv({
      day: { recipe: null, health: 100, weather: 'sunny', temp_c: 22, location: '北京' },
      acts: [{ unit_id: 'short_trip_movie', kind: 'short_trip', title: '看电影', start_min: 800, end_min: 935, interruptible: 0, reply_chance: 0.2 }],
    });
    expect((await lifePromptLine(busy, NOW))!).toContain('多半不看手机');
    // 只靠 reply_chance 也能判定为「忙」——设计原则 5 的查表，不靠模型猜
    const shopping = fakeEnv({
      day: { recipe: null, health: 100, weather: 'sunny', temp_c: 22, location: '北京' },
      acts: [{ unit_id: 'outing_mall', kind: 'outing', title: '逛街', start_min: 800, end_min: 960, interruptible: 1, reply_chance: 0.15 }],
    });
    expect((await lifePromptLine(shopping, NOW))!).toContain('多半不看手机');
    const free = fakeEnv({
      day: { recipe: null, health: 100, weather: 'sunny', temp_c: 22, location: '北京' },
      acts: [{ unit_id: 'idle_bed', kind: 'idle', title: '躺着', start_min: 600, end_min: 1200, interruptible: 1 }],
    });
    expect((await lifePromptLine(free, NOW))!).toContain('随时能停下');
  });

  it('生病日会明确说身体不行，且不许反复诉苦', async () => {
    const env = fakeEnv({
      day: { recipe: 'sick', health: 42, weather: 'cloudy', temp_c: 12, location: '北京' },
      acts: [{ unit_id: 'idle_bed', kind: 'idle', title: '躺着', start_min: 600, end_min: 1200, interruptible: 1 }],
    });
    const line = (await lifePromptLine(env, NOW))!;
    expect(line).toContain('病');
    expect(line).toContain('别反复诉苦');
  });

  it('心情/身体都正常时不啰嗦身体', async () => {
    const env = fakeEnv({
      day: { recipe: null, health: 100, weather: 'sunny', temp_c: 22, location: '北京' },
      acts: [{ unit_id: 'outing_walk', kind: 'outing', title: '散步', start_min: 800, end_min: 860, interruptible: 1 }],
    });
    const line = (await lifePromptLine(env, NOW))!;
    expect(line).not.toContain('病');
    expect(line.split('\n').length).toBeLessThanOrEqual(6);
  });
});

describe('迟回的依据', () => {
  it('在忙的时候来消息：告诉她刚看到，而且别写长', async () => {
    const env = fakeEnv({
      day: { recipe: null, health: 100, weather: 'sunny', temp_c: 22, location: '上海' },
      acts: [{ unit_id: 'bath', kind: 'chore', title: '洗澡', start_min: 800, end_min: 900, interruptible: 0, reply_chance: 0 }],
    });
    const line = (await lifePromptLine(env, NOW))!;
    expect(line).toContain('洗澡的时候发来的');
    expect(line).toContain('别写长');
  });

  it('半夜来的消息：说刚醒，不许装作守着手机', async () => {
    const night = new Date('2026-11-02T03:10:00+08:00');
    const env = fakeEnv({ day: { recipe: null, health: 100, weather: null, temp_c: null, location: '上海' }, acts: [] });
    const line = (await lifePromptLine(env, night))!;
    expect(line).toContain('睡觉的时候发来的');
    expect(line).toContain('刚醒');
  });

  it('闲着的时候不加这句（不然每轮都在解释自己）', async () => {
    const env = fakeEnv({
      day: { recipe: null, health: 100, weather: 'sunny', temp_c: 22, location: '上海' },
      acts: [{ unit_id: 'x', kind: 'chore', title: '看书', start_min: 800, end_min: 900, interruptible: 1, reply_chance: 1 }],
    });
    const line = (await lifePromptLine(env, NOW))!;
    expect(line).not.toContain('发来的');
  });
});
