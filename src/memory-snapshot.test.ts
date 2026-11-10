import { describe, expect, it } from 'vitest';
import {
  listSnapshots,
  pruneSnapshots,
  restoreSnapshot,
  snapshotKey,
  writeDailySnapshot,
} from './memory-snapshot';
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

  it('热目录只留最近 keep 份，其余搬去冷存而不是删除（2026-11-10）', async () => {
    const initial: Record<string, string> = {};
    for (let i = 1; i <= 10; i++) initial[snapshotKey(day(i))] = 'x';
    const { env, store } = fakeEnv(initial);
    const removed = await pruneSnapshots(env, 3);
    expect(removed).toHaveLength(7);
    // 热目录只剩最近 3 份
    expect(
      [...store.keys()].filter((k) => k.startsWith('memory/snapshots/')).sort(),
    ).toEqual([day(8), day(9), day(10)].map(snapshotKey).sort());
    // 被搬走的 7 份仍在冷存里——记忆不删除，只是更难被召回
    const cold = [...store.keys()].filter((k) => k.startsWith('memory/snapshots-cold/'));
    expect(cold).toHaveLength(7);
    expect(store.get('memory/snapshots-cold/2026-10-01.md')).toBe('x');
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
describe('restoreSnapshot', () => {
  it('恢复成功：写入目标快照内容，并先备份现役记忆', async () => {
    const { env, store } = fakeEnv({
      'memory/snapshots/2026-10-29.md': '# 记忆\n旧版本',
      'memory.md': '# 记忆\n当前版本',
    });
    const r = await restoreSnapshot(env, '2026-10-29');
    expect(r.restored).toBe(true);
    expect(r.bytes).toBe('# 记忆\n旧版本'.length);
    expect(store.get('memory.md')).toBe('# 记忆\n旧版本');
    expect(r.backupKey).not.toBeNull();
    expect(store.get(r.backupKey!)).toBe('# 记忆\n当前版本');
  });

  it('日期格式不对直接拒绝，不动任何数据', async () => {
    const { env, store } = fakeEnv({ 'memory.md': '现在' });
    const r = await restoreSnapshot(env, '2026-13-99x');
    expect(r.reason).toBe('bad_date');
    expect(store.get('memory.md')).toBe('现在');
  });

  it('快照不存在时明确报 missing，不覆盖现役记忆', async () => {
    const { env, store } = fakeEnv({ 'memory.md': '现在' });
    const r = await restoreSnapshot(env, '2026-01-01');
    expect(r.reason).toBe('missing');
    expect(store.get('memory.md')).toBe('现在');
  });

  it('已有一把锁时拒绝并发恢复', async () => {
    const { env, store } = fakeEnv({
      'memory/snapshots/2026-10-29.md': '旧',
      'memory.md': '现在',
    });
    await (env as any).KV.put('memory:restore-lock', '1');
    const r = await restoreSnapshot(env, '2026-10-29');
    expect(r.reason).toBe('locked');
    expect(store.get('memory.md')).toBe('现在');
  });

  it('恢复完成后释放锁（可以再恢复一次）', async () => {
    const { env } = fakeEnv({
      'memory/snapshots/2026-10-29.md': '旧',
      'memory.md': '现在',
    });
    await restoreSnapshot(env, '2026-10-29');
    expect(await (env as any).KV.get('memory:restore-lock')).toBeNull();
    const again = await restoreSnapshot(env, '2026-10-29');
    expect(again.restored).toBe(true);
  });

  it('空快照不覆盖现役记忆', async () => {
    const { env, store } = fakeEnv({ 'memory/snapshots/2026-10-29.md': '   ', 'memory.md': '现在' });
    const r = await restoreSnapshot(env, '2026-10-29');
    expect(r.reason).toBe('empty');
    expect(store.get('memory.md')).toBe('现在');
  });
});


