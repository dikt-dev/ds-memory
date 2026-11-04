import { describe, expect, it } from 'vitest';
import { getMemory, putMemory, MEMORY_KV_KEY, MEMORY_R2_KEY } from './memory';
import type { Env } from './types';

/** 最小 R2/KV 替身：只实现 memory.ts 用到的方法。 */
function fakeEnv(opts: { failPut?: boolean; truncateOnWrite?: boolean } = {}) {
  const kv = new Map<string, string>();
  const r2 = new Map<string, string>();
  const env = {
    KV: {
      get: async (k: string) => kv.get(k) ?? null,
      put: async (k: string, v: string) => {
        kv.set(k, v);
      },
      delete: async (k: string) => {
        kv.delete(k);
      },
    },
    R2: {
      put: async (k: string, v: string) => {
        if (opts.failPut) throw new Error('r2 put failed');
        r2.set(k, opts.truncateOnWrite ? String(v).slice(0, 5) : String(v));
      },
      get: async (k: string) => {
        const value = r2.get(k);
        if (value === undefined) return null;
        return { size: value.length, text: async () => value, arrayBuffer: async () => new ArrayBuffer(0) };
      },
      head: async (k: string) => {
        const value = r2.get(k);
        return value === undefined ? null : { size: value.length };
      },
    },
  } as unknown as Env;
  return { env, kv, r2 };
}

describe('putMemory 写后校验', () => {
  it('写入成功时返回 true，并刷新 R2 与 KV', async () => {
    const { env, kv, r2 } = fakeEnv();
    const ok = await putMemory(env, '# 记忆\n- [26-10-29] 事实。');
    expect(ok).toBe(true);
    expect(r2.get(MEMORY_R2_KEY)).toBe('# 记忆\n- [26-10-29] 事实。');
    expect(kv.get(MEMORY_KV_KEY)).toBe('# 记忆\n- [26-10-29] 事实。');
  });

  it('R2 put 抛错时返回 false，且旧缓存原样保留（不制造新的一致性问题）', async () => {
    const { env, kv, r2 } = fakeEnv();
    await putMemory(env, '旧记忆');
    const failing = fakeEnv({ failPut: true });
    failing.kv.set(MEMORY_KV_KEY, '旧记忆');
    const ok = await putMemory(failing.env, '新记忆');
    expect(ok).toBe(false);
    expect(failing.kv.get(MEMORY_KV_KEY)).toBe('旧记忆');
    expect(failing.r2.has(MEMORY_R2_KEY)).toBe(false);
    // 对照组：正常 env 确实写进去了
    expect(r2.get(MEMORY_R2_KEY)).toBe('旧记忆');
  });

  it('读回内容不一致时返回 false，并作废缓存（不能缓存一个不确定的版本）', async () => {
    const { env, kv } = fakeEnv({ truncateOnWrite: true });
    kv.set(MEMORY_KV_KEY, '旧记忆');
    const ok = await putMemory(env, '这段内容会被截断');
    expect(ok).toBe(false);
    expect(kv.has(MEMORY_KV_KEY)).toBe(false);
  });
});

describe('getMemory 回源', () => {
  it('KV 未命中时回源 R2 并回填缓存', async () => {
    const { env, kv, r2 } = fakeEnv();
    r2.set(MEMORY_R2_KEY, '# 记忆\n- 旧事实');
    expect(kv.has(MEMORY_KV_KEY)).toBe(false);
    expect(await getMemory(env)).toBe('# 记忆\n- 旧事实');
    expect(kv.get(MEMORY_KV_KEY)).toBe('# 记忆\n- 旧事实');
  });

  it('R2 也没有时返回空串（首次使用不报错）', async () => {
    const { env } = fakeEnv();
    expect(await getMemory(env)).toBe('');
  });
});
