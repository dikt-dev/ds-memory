/**
 * 每日上下文文件（R2 context/YYYY-MM-DD.json）：
 * 日期、星期、节假日为确定性日历信息（首次使用时生成）；天气由聊天时逐步记录快照；
 * 每日归档时把当天提炼结果（distilled_summary）一并写入。
 */
import type { Env } from './types';
import type { WeatherInfo } from './prompt';
import type { RelationStatus } from './attitude';
import { buildDayContext } from './holidays';
import { isoInBeijing } from './date';
import { getObject, putObject } from './storage';

export interface DayContextFile {
  date: string;
  weekday: string;
  is_holiday: boolean;
  holiday_note: string;
  weather: WeatherInfo | null;
  /** 每天归档时写入：当天对话的提炼结果（memory.md 条目格式） */
  distilled_summary?: string;
  /** 提炼结果写入时间 */
  distilled_at?: string;
  /** 关系状态（好感度/亲密度 + 综合态度），每 8 小时与归档时刷新 */
  relation?: RelationSnapshot | null;
}

export interface RelationSnapshot extends RelationStatus {
  updated_at: string;
}

/** 兼容旧字段名（relation 里现在有 mood） */
export type RelationSnapshotV2 = RelationStatus & { updated_at: string };

export const contextKey = (dateKey: string) => `context/${dateKey}.json`;

/**
 * 当日上下文的 isolate 内缓存（60 秒）。
 *
 * 解决：每条聊天消息都要 getObject 读一次 R2，而这份文件一分钟内几乎不会变。
 * 写入方全部在本文件（attachWeather/attachRelation/attachDistillation），写完立即失效。
 * 多 isolate 间最多脏 60 秒（天气/关系快照晚一分钟无影响）。
 */
const CTX_CACHE_TTL_MS = 60 * 1000;
const ctxCache = new Map<string, { at: number; value: DayContextFile }>();

function cacheGet(dateKey: string): DayContextFile | null {
  const hit = ctxCache.get(dateKey);
  if (!hit) return null;
  if (Date.now() - hit.at > CTX_CACHE_TTL_MS) {
    ctxCache.delete(dateKey);
    return null;
  }
  return hit.value;
}

function cachePut(dateKey: string, value: DayContextFile): void {
  // 简单上限：isolate 存活期不会跨太多天，主要是防止异常调用把 Map 涨爆
  if (ctxCache.size > 16) ctxCache.clear();
  ctxCache.set(dateKey, { at: Date.now(), value });
}

/** 写完立即失效，避免读到旧快照。 */
function cacheDrop(dateKey: string): void {
  ctxCache.delete(dateKey);
}

/**
 * 读取（或首次创建）当天上下文文件。
 *
 * `current` 可由调用方传入它刚读到的结果：同一个 tick 里多处需要上下文时，
 * 省掉重复的 R2 读（与 attachWeather 的约定一致）。
 */
export async function getOrCreateDayContext(
  env: Env,
  dateKey: string,
  current?: DayContextFile,
): Promise<DayContextFile> {
  if (current && current.date === dateKey) return current;
  const cached = cacheGet(dateKey);
  if (cached) return cached;

  const key = contextKey(dateKey);
  const obj = await getObject(env, key);
  if (obj) {
    try {
      const parsed = JSON.parse(await obj.text()) as DayContextFile;
      if (parsed && parsed.date === dateKey && typeof parsed.is_holiday === 'boolean') {
        cachePut(dateKey, parsed);
        return parsed;
      }
    } catch {
      // 文件损坏则重建
    }
  }
  const base = buildDayContext(dateKey);
  const ctx: DayContextFile = { ...base, weather: null };
  await putObject(env, key, JSON.stringify(ctx, null, 2));
  cachePut(dateKey, ctx);
  return ctx;
}

/**
 * 把当天天气快照写进上下文文件（凌晨归档时作为"当天的天气"）。
 *
 * ★ 优化：天气有 30 分钟缓存，同一天内重复写入同一份快照是纯浪费
 *   （每次聊天会调一次，等于每轮多 1 次 R2 读 + 1 次 R2 写）。
 *   - current 可由调用方传入（它刚刚已经读过上下文文件），省掉一次 R2 读；
 *   - 天气没变化时直接返回，不写 R2。
 */
export async function attachWeather(
  env: Env,
  dateKey: string,
  weather: WeatherInfo,
  current?: DayContextFile,
): Promise<void> {
  const ctx = current ?? (await getOrCreateDayContext(env, dateKey));
  const prev = ctx.weather;
  if (prev && prev.city === weather.city && prev.temp_c === weather.temp_c && prev.desc === weather.desc) {
    return; // 快照没变，不写
  }
  await putObject(env, contextKey(dateKey), JSON.stringify({ ...ctx, weather }, null, 2));
  cacheDrop(dateKey);
}

/** 把当天提炼结果写进上下文文件（每日归档时调用，便于回溯当天要点）。 */
export async function attachDistillation(
  env: Env,
  dateKey: string,
  distilled: string,
  at: Date = new Date(),
): Promise<void> {
  const current = await getOrCreateDayContext(env, dateKey);
  await putObject(
    env,
    contextKey(dateKey),
    JSON.stringify(
      { ...current, distilled_summary: distilled, distilled_at: isoInBeijing(at) },
      null,
      2,
    ),
  );
  cacheDrop(dateKey);
}

/** 把关系状态（好感度/亲密度 + 综合态度）写进上下文文件。 */
export async function attachRelation(
  env: Env,
  dateKey: string,
  status: RelationStatus,
  at: Date = new Date(),
): Promise<void> {
  const current = await getOrCreateDayContext(env, dateKey);
  await putObject(
    env,
    contextKey(dateKey),
    JSON.stringify({ ...current, relation: { ...status, updated_at: isoInBeijing(at) } }, null, 2),
  );
  cacheDrop(dateKey);
}
