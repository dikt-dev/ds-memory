import { describe, expect, it } from 'vitest';
import type { Env } from './types';
import { affectEngineFor, memoryEngineFor, normalizeEngine } from './engine-flags';

const base = {} as Env;

describe('engine flags', () => {
  it('默认 legacy，非法值也回退 legacy', () => {
    expect(memoryEngineFor(base, 'web')).toBe('legacy');
    expect(normalizeEngine('NEXT')).toBe('next');
    expect(normalizeEngine('wat')).toBe('legacy');
  });

  it('QQ 优先用自己的覆盖，网页用 WEB 覆盖', () => {
    const env = {
      MEMORY_ENGINE: 'legacy',
      MEMORY_ENGINE_QQ: 'shadow',
      MEMORY_ENGINE_WEB: 'next',
    } as Env;
    expect(memoryEngineFor(env, 'astrobot')).toBe('shadow');
    expect(memoryEngineFor(env, 'web')).toBe('next');
  });

  it('渠道未设置时回退全局', () => {
    const env = { AFFECT_ENGINE: 'shadow' } as Env;
    expect(affectEngineFor(env, 'astrobot')).toBe('shadow');
    expect(affectEngineFor(env, 'web')).toBe('shadow');
  });
});
