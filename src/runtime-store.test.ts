import { describe, expect, it } from 'vitest';
import type { Env } from './types';
import {
  acquireRuntimeLock,
  cleanupRuntimeState,
  deleteRuntimeState,
  getRuntimeState,
  putRuntimeState,
  releaseRuntimeLock,
} from './runtime-store';

/** 只有 KV 的极简环境：验证 D1 缺失时的回退路径。 */
function kvOnlyEnv() {
  const store = new Map<string, string>();
  const env = {
    KV: {
      get: async (key: string) => store.get(key) ?? null,
      put: async (key: string, value: string) => {
        store.set(key, value);
      },
      delete: async (key: string) => {
        store.delete(key);
      },
    },
  } as unknown as Env;
  return { env, store };
}

describe('runtime-store KV 回退', () => {
  it('读写删除', async () => {
    const { env, store } = kvOnlyEnv();
    expect(await getRuntimeState(env, 'k')).toBeNull();
    await putRuntimeState(env, 'k', 'v');
    expect(await getRuntimeState(env, 'k')).toBe('v');
    await deleteRuntimeState(env, 'k');
    expect(store.has('k')).toBe(false);
  });

  it('锁：第一次抢到，第二次失败，释放后可再抢', async () => {
    const { env } = kvOnlyEnv();
    expect(await acquireRuntimeLock(env, 'lock', 60)).toBe(true);
    expect(await acquireRuntimeLock(env, 'lock', 60)).toBe(false);
    await releaseRuntimeLock(env, 'lock');
    expect(await acquireRuntimeLock(env, 'lock', 60)).toBe(true);
  });

  it('无 D1 时清理是 no-op', async () => {
    const { env } = kvOnlyEnv();
    expect(await cleanupRuntimeState(env)).toBe(0);
  });
});
