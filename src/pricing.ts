/**
 * DeepSeek 计费（阶段 4）：按流式返回的精确 token 用量计算费用（元）。
 * 官方定价（2026-10，api-docs.deepseek.com）：高峰时段为闲时 2 倍；
 * 高峰 = 北京时间工作日（非法定节假日）9:00-12:00、14:00-18:00，其余（含周末/节假日）为闲时。
 */
import type { Env } from './types';
import { isHoliday } from './holidays';
import { beijingHour, dateKeyInBeijing } from './date';

export interface PricingConfig {
  inputCacheHitPeak: number; // 元/百万 tokens（高峰，缓存命中）
  inputCacheMissPeak: number; // 元/百万 tokens（高峰，缓存未命中）
  outputPeak: number; // 元/百万 tokens（高峰，输出）
}

export interface TokenUsage {
  prompt_cache_hit_tokens: number;
  prompt_cache_miss_tokens: number;
  completion_tokens: number;
}

/** 北京时间当前是否处于高峰计费时段。 */
export function isPeakHourInBeijing(d: Date): boolean {
  const dateKey = dateKeyInBeijing(d);
  if (isHoliday(dateKey)) return false; // 周末与法定节假日全天闲时
  const hour = beijingHour(d);
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18);
}

/** 从环境变量加载单价；非法/缺失时回退默认（deepseek-flash 高峰价）。 */
export function loadPricing(env: Env): PricingConfig {
  const num = (v: string | undefined, fallback: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  return {
    inputCacheHitPeak: num(env.PRICE_INPUT_HIT_PEAK, 0.04),
    inputCacheMissPeak: num(env.PRICE_INPUT_MISS_PEAK, 2.0),
    outputPeak: num(env.PRICE_OUTPUT_PEAK, 8.0),
  };
}

/** 官方价目表（高峰价，元/百万 tokens；闲时自动减半）。 */
const OFFICIAL_PRICES: Record<string, PricingConfig> = {
  'deepseek-flash': { inputCacheHitPeak: 0.04, inputCacheMissPeak: 2, outputPeak: 8 },
  'deepseek-v4-pro': { inputCacheHitPeak: 0.3, inputCacheMissPeak: 9, outputPeak: 27 },
};

/** 按模型取单价：当前对话模型（DEEPSEEK_MODEL）用配置值，其他模型用内置官方价目表。 */
export function pricingForModel(env: Env, model: string): PricingConfig {
  if (!model || model === env.DEEPSEEK_MODEL) return loadPricing(env);
  return OFFICIAL_PRICES[model] ?? loadPricing(env);
}

/** 计算一次请求的费用（元）；闲时按高峰价 × 0.5。 */
export function calcCost(usage: TokenUsage, cfg: PricingConfig, at: Date): number {
  const k = isPeakHourInBeijing(at) ? 1 : 0.5;
  const cost =
    (usage.prompt_cache_hit_tokens || 0) * cfg.inputCacheHitPeak * k +
    (usage.prompt_cache_miss_tokens || 0) * cfg.inputCacheMissPeak * k +
    (usage.completion_tokens || 0) * cfg.outputPeak * k;
  return cost / 1_000_000;
}
