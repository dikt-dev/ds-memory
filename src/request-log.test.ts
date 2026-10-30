import { beforeEach, describe, expect, it } from 'vitest';
import {
  percentile,
  pruneRequestLog,
  readPathStats,
  recordRequest,
  resetRequestLogCache,
} from './request-log';

interface Call { sql: string; args: unknown[] }

function makeDb(opts: { rows?: Record<string, unknown>[]; fail?: boolean; changes?: number } = {}) {
  const calls: Call[] = [];
  const db = {
    prepare(sql: string) {
      const mk = (args: unknown[]) => {
        calls.push({ sql, args });
        return {
          run: async () => {
            if (opts.fail) throw new Error('db down');
            return { success: true, meta: { changes: opts.changes ?? 0 } };
          },
          all: async () => {
            if (opts.fail) throw new Error('db down');
            return { results: opts.rows ?? [] };
          },
          first: async () => null,
        };
      };
      return {
        bind: (...args: unknown[]) => mk(args),
        run: async () => {
          if (opts.fail) throw new Error('db down');
          return { success: true };
        },
        all: async () => ({ results: opts.rows ?? [] }),
      };
    },
  };
  return { db, calls };
}

const envOf = (db: unknown, extra: Record<string, unknown> = {}) => ({ DB: db, ...extra }) as never;

beforeEach(() => resetRequestLogCache());

describe('percentile', () => {
  it('空数组返回 0', () => {
    expect(percentile([], 0.5)).toBe(0);
  });
  it('单元素就是它自己', () => {
    expect(percentile([42], 0.95)).toBe(42);
  });
  it('中位数与 p95 取最近邻', () => {
    const v = [10, 20, 30, 40, 50];
    expect(percentile(v, 0.5)).toBe(30);
    expect(percentile(v, 0.95)).toBe(50);
  });
  it('不改原数组顺序', () => {
    const v = [3, 1, 2];
    percentile(v, 0.5);
    expect(v).toEqual([3, 1, 2]);
  });
});

describe('recordRequest', () => {
  it('写入一行，字段齐全且 detail 截断到 500 字', async () => {
    const { db, calls } = makeDb();
    await recordRequest(envOf(db), {
      requestId: 'req-1',
      kind: 'http',
      method: 'POST',
      path: '/api/chat',
      status: 200,
      ms: 1234.6,
      channel: 'web',
      ok: true,
      detail: 'x'.repeat(900),
    });
    const insert = calls.find((c) => c.sql.includes('INSERT INTO request_log'));
    expect(insert).toBeTruthy();
    const args = insert!.args as unknown[];
    expect(args[2]).toBe('req-1');
    expect(args[3]).toBe('http');
    expect(args[4]).toBe('POST');
    expect(args[5]).toBe('/api/chat');
    expect(args[6]).toBe(200);
    expect(args[7]).toBe(1235); // 四舍五入
    expect(args[8]).toBe('web');
    expect(args[9]).toBe(1);
    expect(String(args[10])).toHaveLength(500);
  });

  it('写失败不抛（trace 不能反过来影响请求）', async () => {
    const { db } = makeDb({ fail: true });
    await expect(
      recordRequest(envOf(db), { requestId: 'r', kind: 'cron', path: '0 20 * * *', ms: 5 }),
    ).resolves.toBeUndefined();
  });

  it('REQUEST_LOG=off 时一条都不写', async () => {
    const { db, calls } = makeDb();
    await recordRequest(envOf(db, { REQUEST_LOG: 'off' }), {
      requestId: 'r', kind: 'http', path: '/api/health', ms: 5,
    });
    expect(calls).toHaveLength(0);
  });
});

describe('readPathStats', () => {
  it('按路径聚合，算 p50/p95/最大耗时与错误数', async () => {
    const rows = [
      { at: 1, request_id: 'a', kind: 'http', method: 'GET', path: '/api/day', status: 200, ms: 100, channel: null, ok: 1, detail: null },
      { at: 2, request_id: 'b', kind: 'http', method: 'GET', path: '/api/day', status: 200, ms: 300, channel: null, ok: 1, detail: null },
      { at: 3, request_id: 'c', kind: 'http', method: 'GET', path: '/api/day', status: 500, ms: 900, channel: null, ok: 0, detail: null },
      { at: 4, request_id: 'd', kind: 'http', method: 'GET', path: '/api/health', status: 200, ms: 50, channel: null, ok: 1, detail: null },
    ];
    const { db } = makeDb({ rows });
    const stats = await readPathStats(envOf(db), { windowMs: 3600_000, now: 10 });
    expect(stats).toHaveLength(2);
    const day = stats.find((s) => s.path === '/api/day')!;
    expect(day.count).toBe(3);
    expect(day.maxMs).toBe(900);
    expect(day.p50).toBe(300);
    expect(day.errors).toBe(1); // 500 与 ok=0 都算错
    expect(stats[0].path).toBe('/api/day'); // 按条数降序
  });

  it('查询失败返回空数组而不是抛错', async () => {
    const { db } = makeDb({ fail: true });
    expect(await readPathStats(envOf(db), { windowMs: 3600_000 })).toEqual([]);
  });
});

describe('pruneRequestLog', () => {
  it('删除阈值之前的数据并返回条数', async () => {
    const { db, calls } = makeDb({ changes: 7 });
    const n = await pruneRequestLog(envOf(db), 30);
    expect(n).toBe(7);
    const del = calls.find((c) => c.sql.includes('DELETE FROM request_log'));
    expect(del).toBeTruthy();
  });
});
