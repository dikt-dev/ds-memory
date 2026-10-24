import { describe, expect, it } from 'vitest';
import { OFFLINE_ALERT_HOURS, checkChannelOffline } from './webproactive';

/** 极简 KV + D1 替身：只记录发生了哪些写入。 */
function fakeEnv(heartbeat: Record<string, unknown> | null, alertedAt: string | null = null) {
  const store = new Map<string, string>();
  if (heartbeat) store.set('proactive:heartbeat', JSON.stringify(heartbeat));
  if (alertedAt) store.set('proactive:offline_alert', alertedAt);
  const enqueued: string[] = [];

  const env = {
    KV: {
      get: async (key: string, type?: string) => {
        const v = store.get(key);
        if (v === undefined) return null;
        return type === 'json' ? JSON.parse(v) : v;
      },
      put: async (key: string, value: string) => {
        store.set(key, value);
      },
      delete: async (key: string) => {
        store.delete(key);
      },
    },
    DB: {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => ({
          first: async () => {
            enqueued.push(String(args[0]));
            return { id: 1 };
          },
          run: async () => ({ meta: { changes: 1 } }),
          all: async () => ({ results: [] }),
        }),
      }),
    },
  } as never;
  return { env, store, enqueued };
}

const NOW = new Date('2026-10-24T12:00:00+08:00');

describe('checkChannelOffline（QQ 通道掉线提醒）', () => {
  it('从没收到过心跳时不提醒（刚部署）', async () => {
    const { env } = fakeEnv(null);
    expect(await checkChannelOffline(env, NOW)).toBe('no-heartbeat');
  });

  it('心跳新鲜时视为在线', async () => {
    const { env } = fakeEnv({ at: new Date(NOW.getTime() - 5 * 60000).toISOString() });
    expect(await checkChannelOffline(env, NOW)).toBe('online');
  });

  it(`超过 ${OFFLINE_ALERT_HOURS} 小时没心跳 → 入队提醒`, async () => {
    const { env, enqueued } = fakeEnv({
      at: new Date(NOW.getTime() - (OFFLINE_ALERT_HOURS + 1) * 3600000).toISOString(),
    });
    expect(await checkChannelOffline(env, NOW)).toBe('alerted');
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toContain('没有心跳');
  });

  it('同一个掉线事件只提醒一次', async () => {
    const at = new Date(NOW.getTime() - 6 * 3600000).toISOString();
    const { env, enqueued } = fakeEnv({ at }, at);
    expect(await checkChannelOffline(env, NOW)).toBe('already-alerted');
    expect(enqueued).toHaveLength(0);
  });

  it('恢复后再次掉线可以再提醒', async () => {
    const oldAt = new Date(NOW.getTime() - 10 * 3600000).toISOString();
    const newAt = new Date(NOW.getTime() - 4 * 3600000).toISOString();
    const { env, enqueued } = fakeEnv({ at: newAt }, oldAt); // 已提醒的是上一次掉线
    expect(await checkChannelOffline(env, NOW)).toBe('alerted');
    expect(enqueued).toHaveLength(1);
  });

  it('心跳格式损坏按未知处理，不崩', async () => {
    const { env } = fakeEnv({ at: 'not-a-date' });
    expect(await checkChannelOffline(env, NOW)).toBe('no-heartbeat');
  });

  it('入队失败时返回 enqueue-failed 且不记已提醒', async () => {
    const { env, store } = fakeEnv({
      at: new Date(NOW.getTime() - 8 * 3600000).toISOString(),
    });
    (env as { DB: { prepare: () => unknown } }).DB.prepare = () => ({
      bind: () => ({ first: async () => ({ id: 0 }) }),
    });
    expect(await checkChannelOffline(env, NOW)).toBe('enqueue-failed');
    expect(store.get('proactive:offline_alert')).toBeUndefined();
  });
});
