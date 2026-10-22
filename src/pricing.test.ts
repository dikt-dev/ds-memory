import { describe, expect, it } from 'vitest';
import { calcCost, isPeakHourInBeijing, loadPricing, pricingForModel } from './pricing';
import type { Env } from './types';

const env = {
  PRICE_INPUT_HIT_PEAK: '0.30',
  PRICE_INPUT_MISS_PEAK: '9.0',
  PRICE_OUTPUT_PEAK: '27.0',
} as unknown as Env;

describe('isPeakHourInBeijing', () => {
  it('工作日 9-12、14-18 为高峰', () => {
    expect(isPeakHourInBeijing(new Date('2026-10-19T02:00:00Z'))).toBe(true); // 周一 10:00
    expect(isPeakHourInBeijing(new Date('2026-10-19T07:00:00Z'))).toBe(true); // 周一 15:00
  });

  it('午休/夜间/清晨为闲时', () => {
    expect(isPeakHourInBeijing(new Date('2026-10-19T05:00:00Z'))).toBe(false); // 周一 13:00
    expect(isPeakHourInBeijing(new Date('2026-10-19T13:00:00Z'))).toBe(false); // 周一 21:00
    expect(isPeakHourInBeijing(new Date('2026-10-19T20:00:00Z'))).toBe(false); // 周二 04:00
  });

  it('周末与节假日全天闲时', () => {
    expect(isPeakHourInBeijing(new Date('2026-10-24T02:00:00Z'))).toBe(false); // 周六 10:00
    expect(isPeakHourInBeijing(new Date('2026-10-01T02:00:00Z'))).toBe(false); // 国庆 10:00
  });
});

describe('calcCost', () => {
  const cfg = loadPricing(env);

  it('高峰全价', () => {
    const c = calcCost(
      { prompt_cache_hit_tokens: 1_000_000, prompt_cache_miss_tokens: 0, completion_tokens: 0 },
      cfg,
      new Date('2026-10-19T02:00:00Z'),
    );
    expect(c).toBeCloseTo(0.3, 6);
  });

  it('闲时半价', () => {
    const c = calcCost(
      { prompt_cache_hit_tokens: 1_000_000, prompt_cache_miss_tokens: 0, completion_tokens: 0 },
      cfg,
      new Date('2026-10-19T13:00:00Z'),
    );
    expect(c).toBeCloseTo(0.15, 6);
  });

  it('混合计费（命中 1M + 未命中 2M + 输出 3M，高峰）', () => {
    const c = calcCost(
      { prompt_cache_hit_tokens: 1_000_000, prompt_cache_miss_tokens: 2_000_000, completion_tokens: 3_000_000 },
      cfg,
      new Date('2026-10-19T02:00:00Z'),
    );
    expect(c).toBeCloseTo(0.3 + 18 + 81, 6); // 99.3 元
  });
});

describe('loadPricing', () => {
  it('非法/负值回退默认（flash 高峰价）', () => {
    const bad = { ...env, PRICE_INPUT_HIT_PEAK: 'abc', PRICE_OUTPUT_PEAK: '-1' } as unknown as Env;
    const cfg = loadPricing(bad);
    expect(cfg.inputCacheHitPeak).toBe(0.04);
    expect(cfg.outputPeak).toBe(8);
  });
});

describe('pricingForModel', () => {
  // 模拟当前部署：对话模型 flash，配置单价为 flash 档
  const e = {
    DEEPSEEK_MODEL: 'deepseek-flash',
    PRICE_INPUT_HIT_PEAK: '0.04',
    PRICE_INPUT_MISS_PEAK: '2.0',
    PRICE_OUTPUT_PEAK: '8.0',
  } as unknown as Env;

  it('非当前对话模型使用内置官方价（v4-pro 提炼成本按 v4-pro 计）', () => {
    const v4 = pricingForModel(e, 'deepseek-v4-pro');
    expect(v4.inputCacheHitPeak).toBe(0.3);
    expect(v4.inputCacheMissPeak).toBe(9);
    expect(v4.outputPeak).toBe(27);
  });

  it('当前对话模型使用配置单价', () => {
    const flash = pricingForModel(e, 'deepseek-flash');
    expect(flash.inputCacheHitPeak).toBe(0.04);
    expect(flash.outputPeak).toBe(8);
  });

  it('未知模型回退配置单价', () => {
    const unknown = pricingForModel(e, 'some-other-model');
    expect(unknown.inputCacheHitPeak).toBe(0.04);
  });
});
