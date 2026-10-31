import { describe, expect, it } from 'vitest';
import {
  degradationBreakdown,
  recordDegradation,
  readDegradations,
  totalDegradations,
  type DegradationRow,
} from './degradations';
import type { Env } from './types';

/** 只实现被用到的三种语句：CREATE TABLE / INSERT ... ON CONFLICT / SELECT。 */
function fakeEnv() {
  const rows = new Map<string, number>();
  const env = {
    DB: {
      prepare(sql: string) {
        const stmt = {
          bind(...args: unknown[]) {
            if (sql.includes('INSERT INTO degradation_log')) {
              const key = String(args[0]) + '|' + String(args[1]);
              rows.set(key, (rows.get(key) ?? 0) + Number(args[2]));
            }
            return stmt;
          },
          async run() {
            return { success: true };
          },
          async all() {
            return {
              results: [...rows.entries()].map(([key, hits]) => ({
                day_key: key.split('|')[0],
                component: key.split('|')[1],
                hits,
              })),
            };
          },
        };
        return stmt;
      },
    },
  } as unknown as Env;
  return { env, rows };
}

describe('recordDegradation', () => {
  it('同一部件累加次数', async () => {
    const { env, rows } = fakeEnv();
    await recordDegradation(env, 'r2_read');
    await recordDegradation(env, 'r2_read');
    await recordDegradation(env, 'r2_read', 3);
    const key = [...rows.keys()].find((k) => k.endsWith('|r2_read'))!;
    expect(rows.get(key)).toBe(5);
  });

  it('不同部件分开记', async () => {
    const { env, rows } = fakeEnv();
    await recordDegradation(env, 'r2_read');
    await recordDegradation(env, 'embed');
    expect(rows.size).toBe(2);
  });

  it('记账自己失败也不抛（它就在降级路径上）', async () => {
    const env = { DB: { prepare: () => { throw new Error('db down'); } } } as unknown as Env;
    await expect(recordDegradation(env, 'kv_read')).resolves.toBeUndefined();
  });

  it('读不到表时返回空数组而不是抛错', async () => {
    const env = { DB: { prepare: () => { throw new Error('no table'); } } } as unknown as Env;
    await expect(readDegradations(env, 7)).resolves.toEqual([]);
  });
});

describe('汇总', () => {
  const rows: DegradationRow[] = [
    { day_key: '2026-10-31', component: 'r2_read', hits: 4 },
    { day_key: '2026-10-30', component: 'r2_read', hits: 1 },
    { day_key: '2026-10-31', component: 'embed', hits: 2 },
  ];

  it('总次数跨天求和', () => {
    expect(totalDegradations(rows)).toBe(7);
  });

  it('按部件聚合并倒序', () => {
    expect(degradationBreakdown(rows)).toEqual([
      { component: 'r2_read', hits: 5 },
      { component: 'embed', hits: 2 },
    ]);
  });

  it('空数据不炸', () => {
    expect(totalDegradations([])).toBe(0);
    expect(degradationBreakdown([])).toEqual([]);
  });
});
