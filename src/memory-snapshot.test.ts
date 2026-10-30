import { describe, expect, it } from 'vitest';
import { listSnapshots, pruneSnapshots, snapshotKey, writeDailySnapshot } from './memory-snapshot';
import type { Env } from './types';

function fakeEnv(initial: Record<string, string> = {}, opts: { failPut?: boolean } = {}) {
  const store = new Map(Object.entries(initial));
  const kv = new Map<string, string>();
  const env = {
    KV: {
      get: async (k: string) => kv.get(k) ?? null,
      put: async (k: string, v: string) => { kv.set(k, v); },
      delete: async (k: string) => { kv.delete(k); },
    },
    R2: {
      put: async (k: string, v: string) => {
        if (opts.failPut) throw new Error('r2 down');
        store.set(k, String(v));
      },
      get: async (k: string) => {
        const v = store.get(k);
        if (v === undefined) return null;
        return { size: v.length, text: async () => v, arrayBuffer: async () => new ArrayBuffer(0) };
      },
      head: async (k: string) => (store.has(k) ? { size: store.get(k)!.length } : null),
      list: async ({ prefix = '' }: { prefix?: string }) => ({
        objects: [...store.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })),
        truncated: false,
      }),
      delete: async (k: string) => { store.delete(k); },
    },
  } as unknown as Env;
  return { env, store };
}

describe('writeDailySnapshot', () => {
  it('首次写入成功，内容与传入一致', async () => {
    const { env, store } = fakeEnv();
    const r = await writeDailySnapshot(env, '2026-10-30', '# 记忆');
    expect(r.written).toBe(true);
    expect(r.key).toBe('memory/snapshots/2026-10-30.md');
    expect(store.get(r.key)).toBe('# 记忆');
  });

  it('同一天重跑不覆盖（保留当天开始时的状态）', async () => {
    const { env, store } = fakeEnv({ 'memory/snapshots/2026-10-30.md': '旧内容' });
    const r = await writeDailySnapshot(env, '2026-10-30', '新内容');
    expect(r.written).toBe(false);
    expect(r.skipped).toBe('exists');
    expect(store.get('memory/snapshots/2026-10-30.md')).toBe('旧内容');
  });

  it('R2 写入失败不抛异常，只标记 failed（归档继续）', async () => {
    const { env } = fakeEnv({}, { failPut: true });
    const r = await writeDailySnapshot(env, '2026-10-30', 'x');
    expect(r.written).toBe(false);
    expect(r.skipped).toBe('failed');
  });

  it('MEMORY_SNAPSHOT=off 时整段跳过', async () => {
    const { env, store } = fakeEnv();
    const off = { ...(env as any), MEMORY_SNAPSHOT: 'off' } as Env;
    const r = await writeDailySnapshot(off, '2026-10-30', '# 记忆');
    expect(r.skipped).toBe('disabled');
    expect(store.size).toBe(0);
  });

  it('空内容不写（避免留下空快照）', async () => {
    const { env, store } = fakeEnv();
    const r = await writeDailySnapshot(env, '2026-10-30', '   ');
    expect(r.skipped).toBe('failed');
    expect(store.size).toBe(0);
  });
});

describe('pruneSnapshots', () => {
  const day = (i: number) => `2026-10-${String(i).padStart(2, '0')}`;

  it('只保留最近 keep 份', async () => {
    const initial: Record<string, string> = {};
    for (let i = 1; i <= 10; i++) initial[snapshotKey(day(i))] = 'x';
    const { env, store } = fakeEnv(initial);
    const removed = await pruneSnapshots(env, 3);
    expect(removed).toHaveLength(7);
    expect([...store.keys()].sort()).toEqual([day(8), day(9), day(10)].map(snapshotKey).sort());
  });

  it('数量不足时不删任何东西', async () => {
    const { env } = fakeEnv({ [snapshotKey('2026-10-30')]: 'x' });
    expect(await pruneSnapshots(env, 45)).toEqual([]);
  });

  it('绝不删除不符合命名规则的 key', async () => {
    const initial: Record<string, string> = { 'memory/snapshots/notes.txt': 'keep me' };
    for (let i = 1; i <= 5; i++) initial[snapshotKey(day(i))] = 'x';
    const { env, store } = fakeEnv(initial);
    await pruneSnapshots(env, 2);
    expect(store.has('memory/snapshots/notes.txt')).toBe(true);
  });
});

describe('listSnapshots', () => {
  it('按日期倒序，且过滤非快照对象', async () => {
    const { env } = fakeEnv({
      [snapshotKey('2026-10-28')]: 'a',
      [snapshotKey('2026-10-30')]: 'b',
      [snapshotKey('2026-10-29')]: 'c',
      'memory/snapshots/readme.txt': 'd',
    });
    const list = await listSnapshots(env);
    expect(list.map((x) => x.date)).toEqual(['2026-10-30', '2026-10-29', '2026-10-28']);
  });
});