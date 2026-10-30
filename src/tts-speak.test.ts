import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_TTS_CONFIG, speakWithCache } from './tts-config';
import type { Env } from './types';

function fakeEnv() {
  const kv = new Map<string, string>();
  const r2 = new Map<string, ArrayBuffer>();
  const env = {
    KV: {
      get: async (k: string) => (kv.has(k) ? kv.get(k)! : null),
      put: async (k: string, v: string) => void kv.set(k, v),
    },
    R2: {
      get: async (k: string) => {
        const buf = r2.get(k);
        if (!buf) return null;
        return { size: buf.byteLength, arrayBuffer: async () => buf, text: async () => '' };
      },
      put: async (k: string, body: ArrayBuffer) => void r2.set(k, body),
    },
    AZURE_SPEECH_KEY: 'test-key',
    AZURE_SPEECH_REGION: 'eastus',
  } as unknown as Env;
  return { env, r2 };
}

afterEach(() => vi.restoreAllMocks());

describe('speakWithCache', () => {
  it('第一次合成并写缓存，第二次直接命中不再调 Azure', async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { env, r2 } = fakeEnv();

    const first = await speakWithCache(env, '你好呀', { config: DEFAULT_TTS_CONFIG });
    expect(first.cached).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(r2.size).toBe(1);

    const second = await speakWithCache(env, '你好呀', { config: DEFAULT_TTS_CONFIG });
    expect(second.cached).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second.key).toBe(first.key);
  });

  it('Azure 失败时抛错（交给上层回落），不写缓存', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    const { env, r2 } = fakeEnv();
    await expect(speakWithCache(env, '测试', { config: DEFAULT_TTS_CONFIG })).rejects.toThrow(/Azure TTS/);
    expect(r2.size).toBe(0);
  });

  it('没配密钥时明确报错', async () => {
    const { env } = fakeEnv();
    (env as unknown as Record<string, unknown>).AZURE_SPEECH_KEY = '';
    await expect(speakWithCache(env, '测试', { config: DEFAULT_TTS_CONFIG })).rejects.toThrow(/AZURE_SPEECH_KEY/);
  });
});