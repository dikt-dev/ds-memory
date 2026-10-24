import { describe, expect, it } from 'vitest';
import type { Env } from './types';
import { readEngineMetrics, recordEngineMetric } from './engine-metrics';

const env = {} as Env;

describe('engine-metrics', () => {
  it('指标写失败不抛错', async () => {
    await expect(
      recordEngineMetric(env, {
        channel: 'astrobot',
        kind: 'memory',
        mode: 'shadow',
        oldItems: 2,
        newItems: 1,
        oldBytes: 100,
        newBytes: 80,
        ms: 12,
      }),
    ).resolves.toBeUndefined();
  });

  it('无表时读取返回空', async () => {
    expect(await readEngineMetrics(env, 7)).toEqual([]);
  });
});
