/**
 * 三个渠道（移动/网页、OpenAI 兼容、主动消息）共用的记忆上下文组装。
 *
 * 之前这段逻辑在三处各抄了一遍：取记忆 → 决定带哪份 → 中期/今日摘要二选一 →
 * 召回 → 去重 → 预算。任何一处改口径，另两处就得跟着改（S6 加 evidence 模式时就改了三遍）。
 *
 * 这里只抽「三处完全一致」的部分；带渠道差异的东西（会话历史、文件、主动消息查询、
 * 情绪与态度）仍留在各自文件里。
 */
import type { Env } from './types';
import { getMemory } from './memory';
import { getOrCreateDayContext, type DayContextFile } from './context';
import { fetchWeather } from './weather';
import { resolveHerPlace } from './life/where';
import type { WeatherInfo } from './prompt';
import { readContextSnapshot, contextSnapshotFresh } from './context-snapshot';
import { getRecentMemo, formatRecentMemoBlock } from './recent-memory';
import { getTodaySummary } from './summary';
import { loadPersonaState, buildPersonaDriftLine, type PersonaState } from './persona-drift';
import { buildPromptMemoryFor } from './memory-index';
import { budgetContext, type ContextBudgetResult } from './context-budget';
import { stripDuplicateRecall } from './memory-index';
import { memoryEngineFor } from './engine-flags';
import { dateKeyInBeijing } from './date';

export interface PromptMemory {
  text: string;
  mode: 'full' | 'compact' | 'tiered';
  evidence?: boolean;
}

export interface MemoryPack {
  /** 原始 memory.md（部分调用方还要 parse 关系值）。 */
  memory: string;
  dayCtxFile: DayContextFile;
  weather: WeatherInfo | null;
  ctx: { date: string; weekday: string; is_holiday: boolean; holiday_note: string };
  /** 提示词里带的那份记忆：evidence 模式下就是宪法四节。 */
  promptMemory: PromptMemory;
  /** 原始中期记忆（需要按会话起点重排的渠道用）。 */
  recentMemoRaw: Awaited<ReturnType<typeof getRecentMemo>>;
  /** 已格式化好的中期记忆块；没有就是 null。 */
  recentMemo: string | null;
  /** 今日摘要；中期记忆存在时为 null（避免同一段内容发两遍）。 */
  todaySummary: string | null;
  personaState: PersonaState;
  personaDrift: string | null;
  /** 最近几天的话题标题（快照路径才有） */
  topics?: string;
}

export interface BuildMemoryPackOptions {
  channel: string;
  /** 本会话最早的 created_ms：落在会话内的 memo 条目不重复注入。 */
  sessionStartMs?: number;
  /** 中期记忆最多带几条。 */
  memoMaxItems?: number;
  /** 外部已经取到的天气（避免重复请求）。 */
  weather?: WeatherInfo | null;
}

/**
 * 取记忆与当天上下文，返回三渠道共用的那一包。
 *
 * 注意：这里**不**发召回——召回要带渠道自己的 query/focus，放在各自文件里。
 */
export async function buildMemoryPack(
  env: Env,
  now: Date,
  opts: BuildMemoryPackOptions,
): Promise<MemoryPack> {
  const dateKey = dateKeyInBeijing(now);
  // ★ 先试上下文快照：1 次 KV 读换掉 6~7 次跨区往返（2026-11-08）
  const snap = await readContextSnapshot(env).catch(() => null);
  if (contextSnapshotFresh(snap, now) && snap) {
    const promptMemory = buildPromptMemoryFor(snap.memory, env);
    const recentMemo = snap.memo ?? null;
    return {
      memory: snap.memory,
      dayCtxFile: snap.dayCtx,
      weather: snap.weather ?? snap.dayCtx?.weather ?? null,
      ctx: {
        date: snap.dayCtx?.date ?? dateKey,
        weekday: snap.dayCtx?.weekday ?? '',
        is_holiday: Boolean(snap.dayCtx?.is_holiday),
        holiday_note: snap.dayCtx?.holiday_note ?? '',
      },
      promptMemory,
      recentMemoRaw: null,
      recentMemo,
      todaySummary: recentMemo ? null : snap.summary,
      personaState: snap.personaState,
      personaDrift: buildPersonaDriftLine(snap.personaState),
      topics: snap.topics ?? '',
    } as MemoryPack;
  }
  // 天气跟着她此刻所在的城市（旅游时是目的地），不是网页端设置的城市
  const herPlace = await resolveHerPlace(env, dateKey).catch(() => null);
  const [memory, dayCtxFile, fetchedWeather, recentMemoRaw, summaryRaw, personaState] =
    await Promise.all([
      getMemory(env),
      getOrCreateDayContext(env, dateKey),
      opts.weather !== undefined ? Promise.resolve(opts.weather) : fetchWeather(env, herPlace?.city),
      getRecentMemo(env),
      getTodaySummary(env, dateKey),
      loadPersonaState(env),
    ]);

  const promptMemory = buildPromptMemoryFor(memory, env);
  const weather = fetchedWeather ?? dayCtxFile.weather ?? null;
  const memoBlock = formatRecentMemoBlock(recentMemoRaw, opts.memoMaxItems, opts.sessionStartMs);
  const recentMemo = memoBlock ? memoBlock : null;

  return {
    memory,
    dayCtxFile,
    weather,
    ctx: {
      date: dayCtxFile.date,
      weekday: dayCtxFile.weekday,
      is_holiday: dayCtxFile.is_holiday,
      holiday_note: dayCtxFile.holiday_note,
    },
    promptMemory,
    recentMemoRaw,
    recentMemo,
    todaySummary: recentMemo ? null : summaryRaw,
    personaState,
    personaDrift: buildPersonaDriftLine(personaState),
  };
}

/** 渠道差异部分：召回文本去重 + 装进预算。 */
export function budgetFromPack(
  pack: MemoryPack,
  recallText: string,
  historyTexts: string[],
): { recalled: string; budget: ContextBudgetResult } {
  const recalled = stripDuplicateRecall(
    recallText,
    [...historyTexts, pack.recentMemo, pack.promptMemory.text].filter(
      (t): t is string => typeof t === 'string' && t !== '',
    ),
  );
  const budget = budgetContext({
    core: pack.promptMemory.text,
    recent: pack.todaySummary ?? '',
    rollup: pack.recentMemo ?? '',
    recall: recalled,
  });
  return { recalled, budget };
}

/** 全量注入时跳过 memory 来源召回；evidence 模式必须放行，否则她什么都想不起来。 */
export function shouldSkipMemoryRecall(pack: MemoryPack): boolean {
  return pack.promptMemory.mode === 'full' && !pack.promptMemory.evidence;
}

/** 召回引擎选择（渠道相关，集中一处便于以后按渠道收紧）。 */

