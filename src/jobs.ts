/**
 * 定时任务实现（含失败自动补跑，保证"每天必归档"）。
 * - runDailyArchive：补跑失败日期 + 归档前一天 + AI 提炼合并记忆
 * - runMonthlyMerge：补跑失败月份 + 缺失日期补归档 + 合并月度 JSON + D1 清理
 * 时间口径：Cron 20:00 UTC = 北京时间次日 04:00，归档的是【前一天】自然日。
 */
import type { Env } from './types';
import {
  addDays,
  dateKeyInBeijing,
  daysInMonth,
  isoInBeijing,
  monthKey,
  previousDateKey,
  previousMonthKey,
  subtractMonths,
} from './date';
import { attachDistillation, attachRelation, attachWeather, getOrCreateDayContext } from './context';
import { fetchWeather } from './weather';
import { getMemory, putMemory } from './memory';
import {
  detectAiKeepsakes,
  detectRuleKeepsakes,
  insertKeepsake,
  refreshKeepsakesBlock,
} from './keepsakes';
import { reindexMemory } from './memory-index';
import { backfillMemoryProvenance, embedMemoryChunks, replaceMemoryContext, syncRollupSummaries } from './memory-context-store';
import { cleanupMemoryTables, enqueueMemoryJob, runMemoryJobs } from './memory-jobs';
import { runSelfCheck } from './self-check';
import { runSelfReview } from './self-review';
import { rebuildFactsDoc } from './memory-doc';
import { maybeGenerateRollups } from './memory-rollups';
import { buildRelationStatus } from './attitude';
import { distillDay } from './distill';
import {
  archiveCompletedItems,
  byteLength,
  compactMemoryEntries,
  demoteSectionToBudget,
  reportSectionBudgets,
  demoteSectionEntries,
  memoryDensity,
  mergeMemoryEntry,
  parseRelationValues,
  pruneTransientSections,
  setRelationValues,
} from './memory-maintenance';
import { accumulateCandidates, formatAversionEntry, loadCandidates, mergeAversionEntries, saveCandidates, scanAversions } from './aversion';
import { computeStreak, daysSinceLastUserMessage, countMemoryEntries } from './milestone';
import { collectDayRelationStats } from './relation-stats';
import { maybeReviewPersonaDrift } from './persona-drift';
import {
  commitEmotionSettle,
  grievanceTrustPenalty,
  saveEmotionHistory,
  facetsOf,
  loadEmotionState,
  reviewDayEvents,
  settleEmotionDaily,
  type FacetAccum,
} from './emotion-context';
import { applyEventsToVector, sumFacetDelta } from './emotion-events';
import { sumPendingFacetDelta } from './affect-store';
import { moodFromVector } from './emotion-vector';
import { FACET_KEYS } from './relation-facets';
import { applyRelationDecay } from './memory-maintenance';
import { getDaySummaryRaw, summaryKey } from './summary';
import { checkStorageCapacity, cleanupStaleObjects, deleteObject, getObject, listKeys, putObject } from './storage';
import { pruneSnapshots, writeDailySnapshot } from './memory-snapshot';
import { pruneRecallSamples } from './recall-samples';
import { messagesByDate, assistantReplyTo, type MessageRow } from './db';
import { buildDistillConversation, sanitizeDistilledSummary } from './distill-view';
import { backfillFeedback } from './feedback';
import { addLlmCost } from './llm-cost';
import { cleanupRuntimeState, deleteRuntimeState } from './runtime-store';
import { appendArchiveLines, archiveHasLine, CORE_TARGET_BYTES, getArchiveLines } from './memory-archive';
import { logJob } from './trace';
import { logError, logWarn } from './error-log';

/** 后台任务的日志出口：统一走 [job] 结构化格式，便于按 event 过滤。 */
const logInfo = (msg: string): void => logJob('job.daily', { msg });

export interface DailyArchiveResult {
  target: string;
  messages: number;
  memory_bytes_before: number;
  memory_bytes_after: number;
  distilled: boolean;
  trimmed: boolean;
  catchup_days: string[];
  note?: string;
  /** 提炼失败原因（非空时任务标记 failed，下次自动补提炼）。 */
  distill_error?: string;
}

export interface ArchiveOptions {
  /** false = 只重建 R2 日志/上下文，不改 memory.md、不跑情绪/关系结算。 */
  memory?: boolean;
}

export interface MonthlyMergeResult {
  month: string;
  daily_logs: number;
  messages: number;
  merged: boolean;
  cleaned_d1: number;
  note?: string;
}

const STALE_RUNNING_MS = 2 * 60 * 60 * 1000; // running 超过 2 小时视为可接管（防卡死）

/** 归档目标当天跑完的 done 只是临时快照，次日 04:00 必须允许重跑。 */
export function isProvisionalArchiveRun(runAt: string, target: string): boolean {
  return dateKeyInBeijing(new Date(runAt)) <= target;
}

export async function claimJob(env: Env, jobType: string, target: string): Promise<boolean> {
  const row = await env.DB.prepare(
    'SELECT status, run_at FROM cron_runs WHERE job_type = ? AND target = ?',
  )
    .bind(jobType, target)
    .first<{ status: string; run_at: string }>();
  if (row?.status === 'done') {
    // 白天（尤其归档目标当天）跑的归档只覆盖当时已有的消息，不能算最终完成。
    // 次日 04:00 必须允许重跑；否则后半天的消息会永久漏归档。
    if (!isProvisionalArchiveRun(row.run_at, target)) return false;
    logWarn(`[daily] ${target} 的 done 记录是当天 ${row.run_at} 跑的，视为临时归档，允许重跑`);
  }
  if (row?.status === 'running') {
    const age = Date.now() - new Date(row.run_at).getTime();
    if (Number.isFinite(age) && age < STALE_RUNNING_MS) return false;
  }
  await env.DB.prepare(
    `INSERT INTO cron_runs (job_type, target, status, run_at) VALUES (?, ?, 'running', ?)
     ON CONFLICT(job_type, target) DO UPDATE SET status = 'running', run_at = excluded.run_at`,
  )
    .bind(jobType, target, isoInBeijing())
    .run();
  return true;
}

/**
 * 归档补全：一天的最后一条如果是用户消息，而 AI 的回复落在下一天，
 * 把这条回复也补进当天日志，让对话完整。
 * 注意：她主动选择沉默（silent end）时本来就没有回复，此时保持原样、不补。
 * 只追加，不删除、不改写 D1；月度合并会按 id 去重。
 */
export function completeConversationRows(
  rows: MessageRow[],
  reply: MessageRow | null,
): MessageRow[] {
  if (rows.length === 0 || !reply) return rows;
  const last = rows[rows.length - 1];
  if (last.role !== 'user') return rows;
  if (rows.some((r) => r.id === reply.id)) return rows;
  return [...rows, reply];
}

export async function finishJob(env: Env, jobType: string, target: string, detail: string, ok: boolean): Promise<void> {
  await env.DB.prepare(
    'UPDATE cron_runs SET status = ?, detail = ?, run_at = ? WHERE job_type = ? AND target = ?',
  )
    .bind(ok ? 'done' : 'failed', detail, isoInBeijing(), jobType, target)
    .run();
}

/** 归档单个自然日：消息 → 上下文+天气 → R2 .log → AI 提炼 → 大小维护 → 刷新记忆缓存。 */
export async function archiveOneDay(
  env: Env,
  target: string,
  now: Date,
  opts: ArchiveOptions = {},
): Promise<DailyArchiveResult> {
  const base: DailyArchiveResult = {
    target,
    messages: 0,
    memory_bytes_before: 0,
    memory_bytes_after: 0,
    distilled: false,
    trimmed: false,
    catchup_days: [],
  };
  if (!(await claimJob(env, 'daily_archive', target))) {
    return { ...base, note: '该日期已归档过（幂等跳过）' };
  }

  try {
    // 1) 当天的全部消息（按自然日 date_key 查询）
    const dayRows = await messagesByDate(env, target);
    let rows = dayRows;
    let recoveredFromArchive = false;

    // D1 已被清理、但 R2 已有归档时（例如上次提炼失败后补跑），先从归档恢复消息，
    // 否则会用空数组覆盖掉好日志，导致原始对话永久丢失。
    if (rows.length === 0) {
      // 日归档优先；月度合并后日文件会被删除，此时从月文件里筛出当天。
      const existingDaily = await getObject(env, `chat_logs/${target}.log`).catch(() => null);
      const existingMonth = existingDaily
        ? null
        : await getObject(env, `chat_logs/${target.slice(0, 7)}.json`).catch(() => null);
      const existing = existingDaily ?? existingMonth;
      if (existing) {
        try {
          const parsed = JSON.parse(await existing.text()) as { messages?: MessageRow[] };
          const archivedRows = (parsed.messages ?? []).filter(
            (m) => m && m.date_key === target,
          );
          if (archivedRows.length > 0) {
            rows = archivedRows;
            recoveredFromArchive = true;
            logWarn(`[daily] ${target} D1 已清理，从已有归档恢复 ${rows.length} 条消息`);
          }
        } catch (e) {
          logError(`[daily] ${target} 已有归档解析失败:`, e);
        }
      }
    }

    // 跨天补全：最后一条是用户消息时，把落在下一天的 AI 回复补进当天日志
    if (!recoveredFromArchive) {
      const lastRow = rows[rows.length - 1];
      if (lastRow && lastRow.role === 'user') {
        const reply = await assistantReplyTo(env, lastRow.id).catch(() => null);
        const completed = completeConversationRows(dayRows, reply);
        if (completed !== dayRows) {
          rows = completed;
          logInfo(`[daily] ${target} 补上跨天 AI 回复 #${reply?.id}，保证以 AI 收尾`);
        }
      }
    }

    // 2) 当天上下文 + 天气快照（优先用当天聊天时记录的天气）
    const ctx = await getOrCreateDayContext(env, target);
    const liveWeather = await fetchWeather(env);
    const weather = ctx.weather ?? liveWeather;
    if (weather && !ctx.weather) await attachWeather(env, target, weather);

    // 3) 写存储：chat_logs/YYYY-MM-DD.log（后缀 .log，内容为 JSON）
    const archiveKey = `chat_logs/${target}.log`;
    await putObject(
      env,
      archiveKey,
      JSON.stringify(
        {
          date: target,
          context: {
            date: ctx.date,
            weekday: ctx.weekday,
            is_holiday: ctx.is_holiday,
            holiday_note: ctx.holiday_note,
            weather,
          },
          messages: rows,
        },
        null,
        2,
      ),
    );

    // 只重建日志模式：写完 R2 就返回，不触碰记忆/关系/索引。
    // 给 /api/admin/rearchive-logs 用，避免重复提炼把旧事实又追加一遍。
    if (opts.memory === false) {
      const bytes = byteLength(await getMemory(env));
      const detail = `仅重建归档日志：${rows.length} 条消息；记忆未改（${bytes} 字节）`;
      await finishJob(env, 'daily_archive', target, detail, true);
      return {
        ...base,
        messages: rows.length,
        memory_bytes_before: bytes,
        memory_bytes_after: bytes,
        note: '仅重建日志，未改记忆',
      };
    }

    // ★ 提炼的输入 = 刚写好的当天归档文件里的聊天记录（含跨天补全的 AI 回复）
    let distilledRows = rows;
    try {
      const archived = await getObject(env, archiveKey);
      if (archived) {
        const parsed = JSON.parse(await archived.text()) as { messages?: MessageRow[] };
        if (Array.isArray(parsed.messages) && parsed.messages.length > 0) {
          distilledRows = parsed.messages;
        }
      }
    } catch (e) {
      logError('[daily] read back archive for distill failed, use in-memory rows:', e);
    }

    // 4) AI 提炼当天对话 → 合并进 memory.md（失败不阻断归档）
    let memory = await getMemory(env);
    const memoryBefore = memory;
    const before = byteLength(memory);
    let distilled = false;
    let distillCost = 0;
    // 分项 token：光有"多少钱"解释不了价格波动，把命中/未命中/输出都记下来
    const distillUsage = { hit: 0, miss: 0, out: 0 };
    let usedFallback = false;
    let distillError: string | null = null;
    // ★ 提炼只读当天归档文件（上面刚回读的 distilledRows），不碰其他日期
    if (distilledRows.length > 0) {
      try {
        const daySummary = await getDaySummaryRaw(env, target).catch(() => null);
        // 主动消息（turn_type='proactive'）标注出来，避免提炼时误当成用户说过的话
        // 提炼视图：文件块折叠、占位符压缩、她的长回复截断（详见 distill-view.ts）。
        const conversation =
          buildDistillConversation(distilledRows) +
          (daySummary?.text ? `\n\n今日摘要（滚动提炼）：${daySummary.text}` : '');
        const summary = await distillDay(env, target, conversation, memory);
        if (!summary.text.trim() && summary.backend === 'workers-ai') {
          // 兜底模型返回空内容 → 视为失败，任务标 failed，下次补提炼
          distillError = 'Workers AI 兜底返回空内容';
        }
        // 铭记：规则先跑（零成本、确定性强），再让 v4-pro 挑候选（进待审核，不直接注入）。
        // 任何失败都只记日志，绝不影响当天记忆归档。
        try {
          const ruleHits = await detectRuleKeepsakes(env, now.getTime(), {
            conversation,
            memory,
          });
          for (const k of ruleHits) await insertKeepsake(env, k);
          const aiHits = await detectAiKeepsakes(env, target, conversation);
          for (const k of aiHits) await insertKeepsake(env, k);
          if (ruleHits.length > 0 || aiHits.length > 0) await refreshKeepsakesBlock(env);
        } catch (e) {
          logError('[daily] keepsake detect failed:', e);
        }

        // 收集关系驱动统计（量 → 亲密度，质 → 好感度）
        const streakDays = await computeStreak(env, target);
        const daysSinceInteraction = await daysSinceLastUserMessage(env, now);
        const beforeEntries = countMemoryEntries(memory);

        // 先合并一次（不含关系驱动）以统计新增记忆条目数
        const mergedForCount = mergeMemoryEntry(memory, summary.text, target, {
          streakDays,
          daysSinceInteraction,
        });
        const newEntries = Math.max(0, countMemoryEntries(mergedForCount) - beforeEntries);

        // 收集当天统计（量 + 质），交给驱动模块算两个独立数值
        const stats = await collectDayRelationStats(env, target, newEntries, {
          streakDays,
          daysSinceInteraction,
        }).catch(() => null);
        const merged = mergeMemoryEntry(memory, summary.text, target, {
          streakDays,
          daysSinceInteraction,
          ...(stats ? { intimacy: stats.intimacy, affinity: stats.affinity } : {}),
        });
        if (merged !== memory) {
          memory = merged;
          distilled = true;
        }
        if (stats) {
          logInfo(
            `[daily] relation drivers — 消息 ${stats.intimacy.userMessages} 轮 / 天数 ${stats.intimacy.activeDays} / ` +
              `温暖 ${stats.affinity.warmTurns} / 感谢 ${stats.affinity.gratefulCount} / ` +
              `冒犯 ${stats.affinity.offensiveCount} / 冲突 ${stats.affinity.hadConflict}`,
          );
        }
        distillCost += summary.cost;
        if (summary.usage) {
          distillUsage.hit += summary.usage.prompt_cache_hit_tokens ?? 0;
          distillUsage.miss += summary.usage.prompt_cache_miss_tokens ?? 0;
          distillUsage.out += summary.usage.completion_tokens ?? 0;
        }
        if (summary.backend === 'workers-ai') usedFallback = true;
        // 把当天提炼结果写进 context/{date}.json（方便回溯当天要点；失败不影响归档）
        if (summary.text.trim()) {
          try {
            const digest = sanitizeDistilledSummary(summary.text.trim());
            if (digest) await attachDistillation(env, target, digest, now);
          } catch (e) {
            logError('[daily] attach distillation to context failed:', e);
          }
        }
      } catch (e) {
        distillError = e instanceof Error ? e.message : String(e);
        logError('[daily] distill failed:', e);
      }
    }

    // 4.5) 情感系统天级结算：5 轴增量取整写回 + 芥蒂退 20% + Workers AI 事件回填
    try {
      const emotionState = await loadEmotionState(env, now.getTime());
      // Workers AI 只复核当天「有歧义」的消息（单日最多 8 条），补词典漏检
      const dayUserTexts = rows.filter((r) => r.role === 'user').map((r) => r.content);
      const extraEvents = await reviewDayEvents(env, dayUserTexts, now.getTime());

      let vector = emotionState.vector;
      const facetAccum: FacetAccum = { ...emotionState.facetDelta };
      if (extraEvents.length > 0) {
        vector = applyEventsToVector(vector, extraEvents);
        const d = sumFacetDelta(extraEvents);
        const deltaMap: Array<[keyof typeof d, number]> = [
          ['affection', d.affection],
          ['trust', d.trust],
          ['respect', d.respect],
          ['attraction', d.attraction],
        ];
        for (const [k, v] of deltaMap) {
          if (v) facetAccum[k] = (facetAccum[k] ?? 0) + v;
        }
      }
      // 事件驱动的「喜欢」只做微调（±2）：主仍是互动质量驱动，避免双重计数
      if (facetAccum.affection) {
        facetAccum.affection = Math.min(Math.max(facetAccum.affection, -2), 2);
      }

      // E-15 对账：KV 里的累积器可能因写失败落后于 D1 账本，以账本为准。
      const ledgerDelta = await sumPendingFacetDelta(env, emotionState.at - 60_000);
      if (ledgerDelta) {
        const keys = new Set([...Object.keys(ledgerDelta), ...Object.keys(facetAccum)]);
        let drift = 0;
        for (const key of keys) {
          drift += Math.abs(
            (ledgerDelta[key as keyof typeof ledgerDelta] ?? 0) -
              (facetAccum[key as keyof typeof facetAccum] ?? 0),
          );
        }
        if (drift >= 0.5) {
          logInfo(`[daily] emotion reconcile——KV 与账本不一致(drift=${drift.toFixed(1)})，改用账本`);
          for (const key of Object.keys(facetAccum)) delete facetAccum[key as keyof typeof facetAccum];
          Object.assign(facetAccum, ledgerDelta);
        }
      }

      // E-10 芥蒂联动关系轴：委屈高时轻微扣信任（每天最多 -2）
      const trustPenalty = grievanceTrustPenalty(vector);
      if (trustPenalty !== 0) {
        facetAccum.trust = (facetAccum.trust ?? 0) + trustPenalty;
        logInfo(`[daily] 芥蒂扣信任 ${trustPenalty}（委屈=${Math.round(vector.grievance)}）`);
      }

      const working = {
        ...emotionState,
        vector,
        events: [...emotionState.events, ...extraEvents].slice(-30),
        facetDelta: facetAccum,
      };
      const baseVals = parseRelationValues(memory);
      const settled = settleEmotionDaily(working, facetsOf(baseVals));
      // ★ 心情值是情绪向量的投影：结算时同步回写，保证 memory.md 与向量不脱节
      const nextMood = moodFromVector(vector);
      if (settled.changed || nextMood !== baseVals.mood) {
        memory = setRelationValues(memory, {
          affinity: settled.facets.affection,
          intimacy: baseVals.intimacy,
          mood: nextMood,
          trust: settled.facets.trust,
          respect: settled.facets.respect,
          attraction: settled.facets.attraction,
        });
        distilled = true;
        logInfo(`[daily] emotion settle — ${JSON.stringify(settled.applied)}`);
      }
      // E-11 情绪日线：每天存一份，趋势与复盘都靠它
      await saveEmotionHistory(env, target, {
        vector,
        facets: settled.facets,
        mood: nextMood,
      });
      await commitEmotionSettle(env, working, { catchUp: true });
      if (settled.changed || nextMood !== baseVals.mood) {
        logInfo(`[daily] emotion settle — ${JSON.stringify(settled.applied)} mood=${nextMood}`);
      }
    } catch (e) {
      logError('[daily] emotion settle failed:', e);
    }

    // 维护链计数：四项全 0 且记忆不小 = 维护可能又断了（写了没接线）
    const maintenance = { pruned: 0, archived: 0, compacted: 0, demoted: 0 };

    // 5) 短期区块到期：先把「近期动态」超过 7 天的条目无损搬进档案，再清理
    try {
      const pruned = pruneTransientSections(memory, target);
      if (pruned.removed > 0) {
        await appendArchiveLines(env, pruned.removedLines);
        const archive = await getArchiveLines(env);
        const preserved = pruned.removedLines.every((line) => archiveHasLine(archive, line));
        if (preserved) {
          memory = pruned.text;
          maintenance.pruned = pruned.removed;
          logInfo(`[daily] 近期动态 ${pruned.removed} 条过期条目搬进档案`);
        } else {
          logError('[daily] 近期动态清理中止：档案未确认写入，保留核心层');
        }
      }
    } catch (e) {
      logError('[daily] prune transient failed:', e);
    }

    // 5.5) 已完成事项自动归档：「进行中的事项」里标 [已完成] 且过宽限期的 → 移到「共同经历」
    try {
      const archived = archiveCompletedItems(memory, target);
      if (archived.moved > 0) {
        memory = archived.text;
        maintenance.archived = archived.moved;
        logInfo(`[daily] 已完成事项归档 ${archived.moved} 条：${archived.titles.join('、')}`);
      }
    } catch (e) {
      logError('[daily] archive completed failed:', e);
    }

    // 5.6) 雷区主动学习：扫描当天反感信号，累计后提升写入「雷区与禁忌」
    try {
      const userTexts = (rows ?? [])
        .filter((m) => m.role === 'user')
        .map((m) => m.content);
      const scan = scanAversions(userTexts);
      if (scan.hits.length > 0) {
        const pool = await loadCandidates(env);
        const acc = accumulateCandidates(pool, scan, target);
        await saveCandidates(env, acc.pool);
        if (acc.promoted.length > 0) {
          const entries = acc.promoted.map(formatAversionEntry);
          memory = mergeAversionEntries(memory, entries);
          logInfo(`[daily] 雷区学习 新增 ${entries.length} 条：${acc.promoted.map((p) => p.topic).join('、')}`);
        }
      }
    } catch (e) {
      logError('[daily] aversion learn failed:', e);
    }

    // 5.7/5.8) 记忆质量优先：memory.md 不限大小、不压缩、不删除、不搬档。
    //      「近期动态」仍按 7 天过期规则归档进 R2 档案（前面 5 已做写后验证，本体不丢）。
    const trimmed = false;

    // 维护链健康：一天什么都没收拾、记忆又不小 → 大概率是「写了没接线」
    if (maintenance.pruned + maintenance.archived + maintenance.compacted + maintenance.demoted === 0) {
      const sizeNow = byteLength(memory);
      if (sizeNow > 9000) {
        logWarn('[daily] 维护链四项全 0（' + sizeNow + 'B）：检查 prune/archive/compact/demote 是否还接线');
      }
    }

    // 7) 长期不联系时关系缓慢衰减
    try {
      const inactiveDays = await daysSinceLastUserMessage(env, now);
      const decay = applyRelationDecay(memory, inactiveDays);
      if (decay.changed) {
        memory = decay.text;
        logInfo(`[daily] relation decay: ${decay.note}`);
      }
    } catch (e) {
      logError('[daily] relation decay failed:', e);
    }

    // 6.5) 保守去重：只合并重复条目，不改事实；受保护分区不动。
    //      放在所有 memory 维护之后、写回之前，保证写进 R2 的是紧凑版本。
    // 6.6) 分区预算：共同经历/进行中的事项等超预算时，最旧条目搬进档案（仍可召回）
    //      不加这一步，memory.md 会线性涨到 16KB 然后静默掉成 compact 模式。
    try {
      let demoted = 0;
      for (const b of reportSectionBudgets(memory)) {
        if (!b.over) continue;
        const r = demoteSectionToBudget(memory, b.header, b.budget);
        if (r.removed.length === 0) continue;
        await appendArchiveLines(env, r.removed);
        const archive = await getArchiveLines(env);
        if (r.removed.every((line) => archiveHasLine(archive, line))) {
          memory = r.text;
          demoted += r.removed.length;
        } else {
          logError(`[daily] 分区降级中止：${b.header} 档案未确认写入`);
        }
      }
      maintenance.demoted = demoted;
      if (demoted > 0) logInfo(`[daily] 分区预算：把 ${demoted} 条最旧条目搬进档案`);
    } catch (e) {
      logError('[daily] demote sections failed:', e);
    }

    let compactedRemoved = 0;
    try {
      const beforeDensity = memoryDensity(memory);
      const compacted = compactMemoryEntries(memory);
      compactedRemoved = compacted.removed;
      maintenance.compacted = compacted.removed;
      if (compacted.removed > 0) {
        memory = compacted.text;
        const afterDensity = memoryDensity(memory);
        logInfo(
          `[daily] 记忆去重 ${compacted.removed} 条：${beforeDensity.entries} 条/${beforeDensity.bytes}B → ${afterDensity.entries} 条/${afterDensity.bytes}B`,
        );
      }
    } catch (e) {
      logError('[daily] memory compact failed:', e);
    }

    // 6.6) 超过 24KB 时，把最旧的往事无损搬进档案（只搬不删）；
    //      档案也在 D1 索引里，仍可按需召回，只是不再常驻提示词。
    let archivedCount = 0;
    try {
      for (const header of ['## 共同经历', '## 近期动态', '## 进行中的事项']) {
        if (byteLength(memory) <= CORE_TARGET_BYTES) break;
        const demoted = demoteSectionEntries(memory, header, CORE_TARGET_BYTES, 4);
        if (demoted.removed.length === 0) continue;
        await appendArchiveLines(env, demoted.removed);
        const archive = await getArchiveLines(env);
        const preserved = demoted.removed.every((line) => archiveHasLine(archive, line));
        if (!preserved) {
          logError(`[daily] ${header} 分层中止：档案未确认写入，保留核心层`);
          break;
        }
        memory = demoted.text;
        archivedCount += demoted.removed.length;
      }
      if (archivedCount > 0) {
        logInfo(`[daily] 记忆分层：${archivedCount} 条旧往事搬进档案，memory=${byteLength(memory)}B`);
      }
    } catch (e) {
      logError('[daily] memory demote failed:', e);
    }

    // 6.5) 写前快照：保留「当天开始时的记忆」，一天一份、重跑不覆盖；失败不阻断归档
    const snap = await writeDailySnapshot(env, target, memory);
    try {
      const pruned = await pruneSnapshots(env);
      if (pruned.length > 0) logInfo(`[daily] 快照清理：删除 ${pruned.length} 份超期快照`);
    } catch (e) {
      logError('[daily] 快照清理失败（不影响归档）:', e);
    }

    // 7) 写回 R2 + 强制刷新 KV 缓存（24h TTL）
    const memoryChanged = memory !== memoryBefore;
    const saved = await putMemory(env, memory);
    if (!saved) {
      logError('[daily] 记忆写回失败（R2 读回校验未通过），跳过索引与 context 重建，避免两者不一致');
    }
    // 重建 D1 记忆检索索引（幂等；失败不影响归档，下次可手动 /api/admin/memory/reindex）
    // memory 没变就不重建：全量 reindex + context 重写是这条链路里最贵的一步，
    // 而"当天没有新记忆"（比如整天都在闲聊）并不罕见。
    if (saved && memoryChanged) try {
      const idx = await reindexMemory(env);
      if (idx.errors) logError('[daily] memory reindex failed:', idx.errors);
      else logInfo(`[daily] 记忆索引重建：${idx.entries} 条，含向量 ${idx.withVec} 条`);
    } catch (e) {
      logError('[daily] memory reindex error:', e);
    } else if (saved) {
      logInfo('[daily] memory 未变化，跳过索引重建');
    }
    // Phase 2：同步 Memory Context（facts/events/chunks）；表未迁移时只记录，不影响归档。
    if (saved && memoryChanged) try {
      const ctx = await replaceMemoryContext(env, memory, 'memory');
      logInfo(
        `[daily] memory context：facts=${ctx.facts} events=${ctx.events} chunks=${ctx.chunks}`,
      );
    } catch (e) {
      logError('[daily] memory context sync failed:', e);
    }
    // 时间金字塔：周一滚上周摘要、每月 1 日滚上月摘要（幂等，失败不影响归档）
    try {
      const rl = await maybeGenerateRollups(env, now);
      if (rl.generated.length) logInfo(`[daily] 记忆摘要滚动：${rl.generated.join('、')}`);
      if (rl.errors.length) logError('[daily] rollup errors:', rl.errors.join(';'));
    } catch (e) {
      logError('[daily] rollup error:', e);
    }
    // Phase 2B：摘要同步 + 来源回填走可重试任务；表未迁移时回退直接执行。
    try {
      await enqueueMemoryJob(env, 'sync_summaries', 'rollups', now.getTime());
      await enqueueMemoryJob(env, 'sync_archive', 'archive.md', now.getTime());
      await enqueueMemoryJob(env, 'embed_chunks', 'chunks', now.getTime());
      await enqueueMemoryJob(env, 'backfill_provenance', 'memory', now.getTime());
      await enqueueMemoryJob(env, 'extract_conversation', 'recent', now.getTime());
      // 一天只跑 5 个会积压（提炼失败补跑日尤其明显）：跑到队列空或时间用完为止。
      let processed = 0;
      let failedJobs = 0;
      const jobDeadline = Date.now() + 60_000;
      for (let round = 0; round < 6; round++) {
        const jobs = await runMemoryJobs(env, now, 5);
        processed += jobs.processed;
        failedJobs += jobs.failed;
        if (jobs.failed) logError('[daily] memory jobs failed:', JSON.stringify(jobs.details));
        if (jobs.processed === 0 || Date.now() > jobDeadline) break;
      }
      logInfo(`[daily] memory jobs：${processed} 个完成，失败 ${failedJobs}`);
      // 兜底：任务队列失败时也保证重建后的 chunks 有向量，避免静默退化到纯关键词。
      const embedded = await embedMemoryChunks(env, 200).catch((e) => {
        logError('[daily] embedding fallback failed:', e);
        return 0;
      });
      if (embedded > 0) logInfo(`[daily] embedding fallback：${embedded} 条`);
      // ADR-001 S12：每晚重建给人看的 facts.md（只读投影，不进提示词）。
      try {
        const doc = await rebuildFactsDoc(env, dateKeyInBeijing(now));
        logInfo(`[daily] facts.md：${doc.facts} 条 / ${doc.bytes} 字节`);
      } catch (e) {
        logError('[daily] facts.md rebuild failed:', e);
      }
      // ADR-001 S9：自审（默认关，SELF_REVIEW=on 才跑；只执行 A 档动作）。
      if (env.SELF_REVIEW === 'on') {
        try {
          const review = await runSelfReview(env, now.getTime());
          logInfo(
            `[daily] 自审：提案 ${review.proposals}，接受 ${review.accepted.length}，执行 ${review.applied}`,
          );
        } catch (e) {
          logError('[daily] self-review failed:', e);
        }
      }
      // ADR-001 S8：每夜自检——引文回查、孤儿、断链，坏了就自己降权。
      try {
        const check = await runSelfCheck(env, now.getTime());
        logInfo(
          `[daily] 自检：事件 ${check.events} / 引文不一致 ${check.quoteMismatches.length} / 孤儿 ${check.orphans.length} / 断链 ${check.brokenLinks}`,
        );
      } catch (e) {
        logError('[daily] self-check failed:', e);
      }
    } catch (e) {
      logError('[daily] memory jobs unavailable, fallback direct:', e);
      try {
        const summaries = await syncRollupSummaries(env);
        const linked = await backfillMemoryProvenance(env);
        const embedded = await embedMemoryChunks(env, 200).catch(() => 0);
        logInfo(
          `[daily] memory context fallback：summaries=${summaries} provenance=${linked} embedded=${embedded}`,
        );
      } catch (fallbackError) {
        logError('[daily] memory context fallback failed:', fallbackError);
      }
    }
    // 当天已归档，清理滚动摘要（新的一天用新键）
    await deleteRuntimeState(env, summaryKey(target)).catch(() => {});
    // 关系状态写入当天上下文（好感度/亲密度 + 综合态度）
    try {
      const relation = parseRelationValues(memory);
      await attachRelation(env, target, buildRelationStatus(relation.affinity, relation.intimacy, relation.mood), now);
    } catch (e) {
      logError('[daily] attach relation failed:', e);
    }
    const after = byteLength(memory);
    // 提炼/压缩的费用不在 messages 表里，单独记账到 KV，供 /api/usage 汇总
    await addLlmCost(env, target, distillCost);
    const costInfo =
      distillCost > 0
        ? `；提炼费用 ¥${distillCost.toFixed(4)}${usedFallback ? '（部分用 Workers AI 兜底）' : ''}` +
          (distillUsage.out > 0
            ? `；token 命中${distillUsage.hit}/未命中${distillUsage.miss}/输出${distillUsage.out}`
            : '')
        : usedFallback
          ? '；提炼用 Workers AI 兜底'
          : '';
    const errorInfo = distillError ? `；提炼错误=${distillError.slice(0, 160)}` : '';
    const snapInfo = snap.written ? '；快照=写入' : snap.skipped === 'exists' ? '；快照=已存在' : snap.skipped === 'disabled' ? '' : '；快照=失败';
    const detail = `归档 ${rows.length} 条消息；记忆 ${before}→${after} 字节；提炼=${distilled}${costInfo}；去重=${compactedRemoved}；分层=${archivedCount}；裁剪=${trimmed}${snapInfo}${errorInfo}`;
    // 提炼失败时不把任务标 done：runDailyArchive 下次会把它当 failed 补跑
    await finishJob(env, 'daily_archive', target, detail, !distillError);
    return {
      target,
      messages: rows.length,
      memory_bytes_before: before,
      memory_bytes_after: after,
      distilled,
      trimmed,
      catchup_days: [],
      ...(distillError ? { distill_error: distillError } : {}),
      note: distillError ? `提炼失败，已保留归档等待补跑：${distillError}` : undefined,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logError('[daily] archive failed for', target, e);
    await finishJob(env, 'daily_archive', target, msg, false).catch(() => {});
    throw e;
  }
}

/** 判断某天的聊天记录是否已经有安全归档（日文件或月文件）。 */
async function hasArchivedDate(env: Env, dateKey: string): Promise<boolean> {
  const daily = await getObject(env, `chat_logs/${dateKey}.log`).catch(() => null);
  if (daily) return true;
  const month = await getObject(env, `chat_logs/${dateKey.slice(0, 7)}.json`).catch(() => null);
  if (!month) return false;
  try {
    const parsed = JSON.parse(await month.text()) as { messages?: MessageRow[] };
    return (parsed.messages ?? []).some((m) => m.date_key === dateKey);
  } catch {
    return false;
  }
}

/**
 * D1 只保留今天和昨天：更早的日期必须已归档才删除，没归档绝不删。
 * 归档文件在 R2，短期记忆需要时会从归档回补。
 */
export async function cleanupOldMessages(
  env: Env,
  now: Date,
): Promise<{ deleted: number; keptFrom: string; dates: string[] }> {
  const today = dateKeyInBeijing(now);
  const keptFrom = previousDateKey(today); // 保留 >= 昨天
  const [rows, jobs] = await Promise.all([
    env.DB.prepare(
      'SELECT DISTINCT date_key FROM messages WHERE date_key < ? ORDER BY date_key ASC LIMIT 60',
    )
      .bind(keptFrom)
      .all<{ date_key: string }>(),
    env.DB.prepare(
      "SELECT target, status, detail FROM cron_runs WHERE job_type = 'daily_archive'",
    ).all<{ target: string; status: string; detail: string | null }>(),
  ]);
  const jobMap = new Map((jobs.results ?? []).map((r) => [r.target, r]));
  const deletedDates: string[] = [];
  let deleted = 0;
  for (const row of rows.results ?? []) {
    const d = row.date_key;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    // 只有「归档 + 提炼都成功」的日期才允许删 D1；提炼失败的日期要留给补跑。
    const job = jobMap.get(d);
    if (!job || job.status !== 'done') continue;
    if ((job.detail ?? '').includes('提炼错误')) continue;
    if (!(await hasArchivedDate(env, d))) continue;
    // 先记墓碑再删：App 本地库靠它把服务端删掉的消息一起删掉
  const doomed = await env.DB.prepare('SELECT id FROM messages WHERE date_key = ?')
    .bind(d)
    .all<{ id: number }>()
    .catch(() => null);
  for (const row of doomed?.results ?? []) {
    await env.DB.prepare('INSERT OR IGNORE INTO message_tombstones (id, deleted_at) VALUES (?, ?)')
      .bind(row.id, Date.now())
      .run()
      .catch(() => {});
  }
  const res = await env.DB.prepare('DELETE FROM messages WHERE date_key = ?').bind(d).run();
    deleted += res.meta.changes ?? 0;
    deletedDates.push(d);
  }
  return { deleted, keptFrom, dates: deletedDates };
}

const CATCHUP_LIMIT = 7;
const CATCHUP_SCAN_LIMIT = 20;

/**
 * 找出需要补归档的日期：
 * 1) cron_runs 里 failed 的日期；
 * 2) 超过 2 小时仍卡在 running 的任务；
 * 3) D1 里还有消息、但 R2 没有归档的日期（Worker 当天完全没跑过时不会有 cron_runs 行）。
 */
/** 某天在 D1 里还有没有消息。 */
async function hasMessages(env: Env, dateKey: string): Promise<boolean> {
  const row = await env.DB.prepare('SELECT 1 AS n FROM messages WHERE date_key = ? LIMIT 1')
    .bind(dateKey)
    .first<{ n: number }>();
  return Boolean(row);
}

/**
 * 历史日期的失败/卡死任务，如果「当天没消息 + R2 已有归档」，
 * 说明无事可做：直接标 done，否则会每天占用补跑名额空转（甚至卡死）。
 */
async function settleEmptyArchive(env: Env, dateKey: string): Promise<boolean> {
  if (await hasMessages(env, dateKey)) return false;
  if (!(await hasArchivedDate(env, dateKey))) return false;
  await finishJob(env, 'daily_archive', dateKey, '无消息且已归档，跳过补跑', true);
  logInfo(`[daily] ${dateKey} 无消息且已归档，标记完成不再补跑`);
  return true;
}

export async function findArchiveCatchupTargets(env: Env, now: Date): Promise<string[]> {
  const prev = previousDateKey(dateKeyInBeijing(now));
  const targets = new Set<string>();

  // 太老的历史失败行是考古，不是补账：清掉，避免永远排在最前面
  const staleTarget = previousDateKey(addDays(prev, -45));
  await env.DB.prepare(
    "DELETE FROM cron_runs WHERE job_type = 'daily_archive' AND status = 'failed' AND target < ?",
  )
    .bind(staleTarget)
    .run()
    .catch(() => undefined);

  const failed = await env.DB.prepare(
    "SELECT target FROM cron_runs WHERE job_type = 'daily_archive' AND status = 'failed' AND target < ? ORDER BY target ASC LIMIT ?",
  )
    .bind(prev, CATCHUP_LIMIT)
    .all<{ target: string }>();
  for (const row of failed.results ?? []) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.target)) continue;
    if (await settleEmptyArchive(env, row.target)) continue;
    targets.add(row.target);
  }

  const staleCutoff = isoInBeijing(new Date(now.getTime() - STALE_RUNNING_MS));
  const stale = await env.DB.prepare(
    "SELECT target FROM cron_runs WHERE job_type = 'daily_archive' AND status = 'running' AND target < ? AND run_at < ? ORDER BY target ASC LIMIT ?",
  )
    .bind(prev, staleCutoff, CATCHUP_LIMIT)
    .all<{ target: string }>();
  for (const row of stale.results ?? []) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.target)) continue;
    if (await settleEmptyArchive(env, row.target)) continue;
    targets.add(row.target);
  }

  // 从 D1 反查“有消息但没归档”的日期；只扫最近 20 个，避免 R2 读放大。
  const candidates = await env.DB.prepare(
    'SELECT DISTINCT date_key FROM messages WHERE date_key < ? ORDER BY date_key ASC LIMIT ?',
  )
    .bind(prev, CATCHUP_SCAN_LIMIT)
    .all<{ date_key: string }>();
  for (const row of candidates.results ?? []) {
    if (targets.size >= CATCHUP_LIMIT) break;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date_key)) continue;
    if (targets.has(row.date_key)) continue;
    if (!(await hasArchivedDate(env, row.date_key))) targets.add(row.date_key);
  }

  return [...targets].sort().slice(0, CATCHUP_LIMIT);
}

/** 每日归档入口：先补跑历史失败/缺失日期（最旧优先，≤7 个），再归档前一天。 */
export async function runDailyArchive(env: Env, now: Date): Promise<DailyArchiveResult> {
  // 存储容量检查：主账号接近上限时，把后续写入切换到小号 R2
  await checkStorageCapacity(env).catch((e) => logError('[storage] capacity check failed:', e));

  // 回填主动消息质量反馈（发出 2 小时后检查用户是否回复）
  await backfillFeedback(env, now).catch((e) => logError('[feedback] backfill failed:', e));

  // 清理：30 天前的已发送队列记录、过期的 context/images 文件
  await cleanupStaleObjects(env, now).catch((e) => logError('[r2] cleanup failed:', e));
  await cleanupRuntimeState(env, now.getTime()).catch((e) => logError('[runtime] cleanup failed:', e));
  // 召回分段采样只留 14 天（一天约 100 行）
  await pruneRecallSamples(env).catch((e) => logError('[recall-samples] prune failed:', e));
  await cleanupMemoryTables(env, now.getTime()).catch((e) =>
    logError('[memory] table cleanup failed:', e),
  );

  const catchupTargets = await findArchiveCatchupTargets(env, now);
  const catchup: string[] = [];
  for (const target of catchupTargets) {
    try {
      const r = await archiveOneDay(env, target, now);
      catchup.push(`${r.target}(${r.messages}条${r.distill_error ? '，提炼待补' : ''})`);
    } catch (e) {
      logError('[daily] catch-up failed for', target, e);
    }
  }

  const target = previousDateKey(dateKeyInBeijing(now));
  const main = await archiveOneDay(env, target, now);
  // 性格缓慢漂移：至少 7 天、15 条用户消息才结算一次，每次每维最多 ±2
  await maybeReviewPersonaDrift(env, now).catch((e) =>
    logError('[persona] weekly review failed:', e),
  );
  // D1 只保留今天和昨天；更早的必须先有归档才删
  const cleanup = await cleanupOldMessages(env, now).catch((e) => {
    logError('[daily] cleanup old messages failed:', e);
    return { deleted: 0, keptFrom: target, dates: [] as string[] };
  });
  const cleanupNote = cleanup.deleted
    ? `；清理已归档旧消息 ${cleanup.deleted} 条（${cleanup.dates.join('、')}），保留 ${cleanup.keptFrom} 起`
    : '';
  return {
    ...main,
    catchup_days: catchup,
    note:
      (catchup.length ? `补跑失败日期：${catchup.join('、')}；${main.note ?? ''}` : main.note) +
      cleanupNote,
  };
}

/** 计算当月还缺哪些日期的归档文件（纯函数，可单测）。 */
export function missingDatesInMonth(month: string, keys: string[]): string[] {
  const present = new Set(keys);
  const total = daysInMonth(month);
  const missing: string[] = [];
  for (let d = 1; d <= total; d++) {
    const dateKey = `${month}-${String(d).padStart(2, '0')}`;
    if (!present.has(`chat_logs/${dateKey}.log`)) missing.push(dateKey);
  }
  return missing;
}

/** 合并多份单日 .log 的纯函数（按消息 id 去重并排序）。 */
export function mergeDailyLogs(
  logs: Array<{ messages: MessageRow[] }>,
): { merged: MessageRow[]; expected: number; duplicates: number; conflicts: number } {
  const map = new Map<number, MessageRow>();
  let expected = 0;
  let duplicates = 0;
  let conflicts = 0;
  for (const log of logs) {
    expected += log.messages.length;
    for (const m of log.messages) {
      const existing = map.get(m.id);
      if (existing) {
        duplicates += 1;
        // 跨天补全会制造合法重复；同 id 不同正文才是异常。
        if (existing.content !== m.content || existing.role !== m.role) conflicts += 1;
      } else {
        map.set(m.id, m);
      }
    }
  }
  return {
    merged: [...map.values()].sort((a, b) => a.id - b.id),
    expected,
    duplicates,
    conflicts,
  };
}

/** 合并单个自然月：先补缺失日期归档，再合并 + 完整性校验 + 清理 D1。 */
async function mergeMonth(env: Env, month: string, now: Date): Promise<MonthlyMergeResult> {
  if (!(await claimJob(env, 'monthly_merge', month))) {
    return { month, daily_logs: 0, messages: 0, merged: false, cleaned_d1: 0, note: '该月已合并过（幂等跳过）' };
  }

  try {
    const monthlyKey = `chat_logs/${month}.json`;
    const prefix = `chat_logs/${month}-`;

    // 1) 缺失日期先补归档（该月数据仍在 D1，可完整重建）
    let keys = (await listKeys(env, prefix)).filter((k) => k.endsWith('.log'));
    for (const date of missingDatesInMonth(month, keys)) {
      try {
        await archiveOneDay(env, date, now);
      } catch (e) {
        logError('[monthly] 补归档失败', date, e);
      }
    }
    keys = (await listKeys(env, prefix)).filter((k) => k.endsWith('.log'));

    // 2) 仍缺天 → 拒绝合并（宁可失败也不能静默丢一天的数据）
    const stillMissing = missingDatesInMonth(month, keys);
    if (stillMissing.length > 0) {
      throw new Error(`当月仍缺 ${stillMissing.length} 天归档（${stillMissing.slice(0, 3).join(',')}…），拒绝合并以防丢失数据`);
    }

    // 3) 读取并合并（按 id 去重排序）
    const logs: Array<{ messages: MessageRow[] }> = [];
    for (const key of keys) {
      const obj = await getObject(env, key);
      if (!obj) continue;
      const parsed = JSON.parse(await obj.text()) as { messages?: MessageRow[] };
      logs.push({ messages: parsed.messages ?? [] });
    }
    const { merged: all, expected, duplicates, conflicts } = mergeDailyLogs(logs);
    // 跨天补全允许同 id 重复；只有内容冲突或去重后数量不等于唯一 id 数才失败。
    if (conflicts > 0 || all.length !== expected - duplicates) {
      throw new Error(
        `完整性校验失败：单日日志合计 ${expected} 条，去重 ${duplicates} 条，合并 ${all.length} 条，冲突 ${conflicts} 条`,
      );
    }

    // 4) 写月度 JSON 并读回校验
    await putObject(env, monthlyKey, JSON.stringify({ month, messages: all }, null, 2));
    const verify = await getObject(env, monthlyKey);
    const verified = JSON.parse((await verify?.text()) ?? '{}') as { messages?: MessageRow[] };
    if ((verified.messages?.length ?? 0) !== all.length) {
      throw new Error('月度文件回读校验失败');
    }

    // 5) 校验通过后删除单日 .log
    for (const key of keys) await deleteObject(env, key);

    // 6) D1 清理：只删除【已成功合并的月份】里、且早于 3 个月前的数据（防丢未归档数据）
    const today = dateKeyInBeijing(now);
    let cleaned = 0;
    const cutoffMonth = monthKey(subtractMonths(today, 3));
    const doneRows = await env.DB.prepare(
      "SELECT target FROM cron_runs WHERE job_type = 'monthly_merge' AND status = 'done'",
    ).all<{ target: string }>();
    const deletableMonths = (doneRows.results ?? [])
      .map((r) => r.target)
      .filter((m) => /^\d{4}-\d{2}$/.test(m) && m < cutoffMonth);
    if (deletableMonths.length > 0) {
      const placeholders = deletableMonths.map(() => '?').join(',');
      const del = await env.DB.prepare(
        `DELETE FROM messages WHERE substr(date_key, 1, 7) IN (${placeholders})`,
      )
        .bind(...deletableMonths)
        .run();
      cleaned = del.meta.changes ?? 0;
    }

    const detail = `合并 ${keys.length} 份单日日志 → ${all.length} 条；清理 D1 ${cleaned} 条`;
    await finishJob(env, 'monthly_merge', month, detail, true);
    return { month, daily_logs: keys.length, messages: all.length, merged: true, cleaned_d1: cleaned };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logError('[monthly] merge failed for', month, e);
    await finishJob(env, 'monthly_merge', month, msg, false).catch(() => {});
    throw e;
  }
}

/** 月度入口：先补跑失败月份（最旧优先，≤3 个），再合并上个月。 */
export async function runMonthlyMerge(env: Env, now: Date): Promise<MonthlyMergeResult> {
  const failed = await env.DB.prepare(
    "SELECT target FROM cron_runs WHERE job_type = 'monthly_merge' AND status = 'failed' ORDER BY target ASC LIMIT 3",
  ).all<{ target: string }>();
  for (const row of failed.results ?? []) {
    if (!/^\d{4}-\d{2}$/.test(row.target)) continue;
    try {
      await mergeMonth(env, row.target, now);
    } catch (e) {
      logError('[monthly] catch-up failed for', row.target, e);
    }
  }
  const today = dateKeyInBeijing(now);
  return mergeMonth(env, previousMonthKey(monthKey(today)), now);
}

/**
 * 每 8 小时刷新当天上下文：
 * 1. 更新天气
 * 2. 把情绪向量的投影（心情值）同步回 memory.md
 * 3. 刷新关系快照
 */
export async function runContextRefresh(env: Env, now: Date): Promise<void> {
  const dateKey = dateKeyInBeijing(now);
  const weather = await fetchWeather(env);
  if (weather) await attachWeather(env, dateKey, weather).catch((e) => logError('[context] weather failed:', e));

  try {
    const memory = await getMemory(env);
    const relation = parseRelationValues(memory);

    // ★ 环境不再直接改 memory.md 的心情值：它作用于情绪向量（见 processEmotionTurn），
    //   这里只把向量的投影同步回来，避免两条链路各推各的。
    const state = await loadEmotionState(env, now.getTime());
    const mood = moodFromVector(state.vector);
    let updatedMemory = memory;
    if (mood !== relation.mood) {
      updatedMemory = setRelationValues(memory, {
        affinity: relation.affinity,
        intimacy: relation.intimacy,
        mood,
        trust: relation.trust,
        respect: relation.respect,
        attraction: relation.attraction,
      });
      await putMemory(env, updatedMemory);
      logInfo(`[context] 心情同步 ${relation.mood} → ${mood}（由情绪向量派生）`);
    }

    const finalRelation = parseRelationValues(updatedMemory);
    await attachRelation(
      env,
      dateKey,
      buildRelationStatus(finalRelation.affinity, finalRelation.intimacy, finalRelation.mood),
      now,
    );
  } catch (e) {
    logError('[context] relation refresh failed:', e);
  }
}
