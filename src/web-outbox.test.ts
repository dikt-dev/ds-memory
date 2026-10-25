import { describe, expect, it } from 'vitest';
import type { Env } from './types';
import { latestWebMessageId, webMessagesSince } from './db';

function fakeEnv(rows: Array<Record<string, unknown>>, capture: { sql?: string; args?: unknown[] }): Env {
  return {
    DB: {
      prepare(sql: string) {
        capture.sql = sql;
        return {
          bind(...args: unknown[]) {
            capture.args = args;
            return {
              all: async () => ({ results: rows }),
              first: async () => ({ id: Number(rows[0]?.id ?? 0) }),
            };
          },
          first: async () => ({ id: Number(rows[0]?.id ?? 0) }),
        };
      },
    },
  } as unknown as Env;
}

describe('webMessagesSince —— 网页→QQ 只取网页普通聊天', () => {
  it('SQL 只查 channel=web 且排除主动消息，避免把 QQ 消息或定时消息再同步回去', async () => {
    const capture: { sql?: string; args?: unknown[] } = {};
    const rows = [
      { id: 11, role: 'user', content: '网页消息', channel: 'web' },
      { id: 12, role: 'assistant', content: '网页回复', channel: 'web' },
    ];
    const env = fakeEnv(rows, capture);
    const result = await webMessagesSince(env, 10, 10);
    expect(capture.sql).toContain("channel = 'web'");
    expect(capture.sql).toContain('proactive_kind IS NULL');
    expect(capture.sql).toContain('id > ?');
    expect(capture.args).toEqual([10, 11]);
    expect(result.messages).toHaveLength(2);
    expect(result.hasMore).toBe(false);
  });

  it('超过 limit 时 hasMore=true 并只返回 limit 条', async () => {
    const capture: { sql?: string; args?: unknown[] } = {};
    const rows = Array.from({ length: 4 }, (_, i) => ({
      id: i + 1,
      role: 'user',
      content: 'x',
      channel: 'web',
    }));
    const env = fakeEnv(rows, capture);
    const result = await webMessagesSince(env, 0, 3);
    expect(result.messages).toHaveLength(3);
    expect(result.hasMore).toBe(true);
  });
});

describe('latestWebMessageId', () => {
  it('只按 channel=web 取最大 id 作为首次基线', async () => {
    const capture: { sql?: string; args?: unknown[] } = {};
    const env = fakeEnv([{ id: 42 }], capture);
    expect(await latestWebMessageId(env)).toBe(42);
    expect(capture.sql).toContain("channel = 'web'");
    expect(capture.sql).toContain('proactive_kind IS NULL');
  });
});
