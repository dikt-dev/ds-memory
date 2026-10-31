/**
 * 提炼 / 压缩 / 摘要这类「非聊天」调用的费用记账。
 *
 * 为什么需要单独记：这些调用都走 distill.ts，费用只被 console.log 或
 * 拼进 cron_runs.detail 的字符串里，从来没有落进 messages 表。
 * 结果就是网页上的「今日费用」严重低估 —— 每日提炼用的是 v4-pro，
 * 单价是 flash 的 7.5~13.5 倍，一天一次全量提炼很可能比日常聊天还贵。
 *
 * 用 D1 runtime_state 按天累加（TTL 8 天）；KV 只作为无 D1 时的回退。
 * 每天只写几次，读-改-写的并发风险可以忽略。
 */
import type { Env } from './types';
import { getRuntimeState, putRuntimeState } from './runtime-store';
import { logError, logWarn } from './error-log';

const costKey = (dateKey: string) => `cost:llm:${dateKey}`;
const TTL_SECONDS = 8 * 24 * 60 * 60;

/** 累加某天的非聊天 LLM 费用（元）。 */
export async function addLlmCost(env: Env, dateKey: string, cost: number): Promise<void> {
  if (!Number.isFinite(cost) || cost <= 0) return;
  try {
    const prev = Number(await getRuntimeState(env, costKey(dateKey))) || 0;
    await putRuntimeState(env, costKey(dateKey), String(prev + cost), TTL_SECONDS);
  } catch (e) {
    logError('[llm-cost] accumulate failed:', e);
  }
}

/** 读取某天的非聊天 LLM 费用（元）。 */
export async function getLlmCost(env: Env, dateKey: string): Promise<number> {
  try {
    const n = Number(await getRuntimeState(env, costKey(dateKey)));
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}
