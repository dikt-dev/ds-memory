/**
 * 定时任务实现（含失败自动补跑，保证"每天必归档"）。
 * - runDailyArchive：补跑失败日期 + 归档前一天 + AI 提炼合并记忆
 * - runMonthlyMerge：补跑失败月份 + 缺失日期补归档 + 合并月度 JSON + D1 清理
 * 时间口径：Cron 20:00 UTC = 北京时间次日 04:00，归档的是【前一天】自然日。
 */
import type { Env } from './types';
import {
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
import { buildRelationStatus } from './attitude';
import { distillDay } from './distill';
import { archiveCompletedItems, byteLength, DEMOTE_HEADERS, demoteSectionEntries, mergeMemoryEntry, parseRelationValues, pruneTransientSections, setRelationValues } from './memory-maintenance';
import { accumulateCandidates, formatAversionEntry, loadCandidates, mergeAversionEntries, saveCandidates, scanAversions } from './aversion';
import { computeStreak, daysSinceLastUserMessage, countMemoryEntries } from './milestone';
import { collectDayRelationStats } from './relation-stats';
import {
  commitEmotionSettle,
  facetsOf,
  loadEmotionState,
  reviewDayEvents,
  settleEmotionDaily,
  type FacetAccum,
} from './emotion-context';
import { applyEventsToVector, sumFacetDelta } from './emotion-events';
import { moodFromVector } from './emotion-vector';
import { FACET_KEYS } from './relation-facets';
import { applyRelationDecay } from './memory-maintenance';
import { getDaySummaryRaw, summaryKey } from './summary';
import { checkStorageCapacity, cleanupStaleObjects, deleteObject, getObject, listKeys, putObject } from './storage';
import { messagesByDate, type MessageRow } from './db';
import { backfillFeedback } from './feedback';
import { cleanupQueue } from './queue';
import { addLlmCost } from './llm-cost';
import { CORE_TARGET_BYTES, appendArchiveLines, archiveHasLine, getArchiveLines } from './memory-archive';

export interface DailyArchiveResult {
  target: string;
  messages: number;
  memory_bytes_before: number;
  memory_bytes_after: number;
  distilled: boolean;
  trimmed: boolean;
  catchup_days: string[];
  note?: string;
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

async function claimJob(env: Env, jobType: string, target: string): Promise<boolean> {
  const row = await env.DB.prepare(
    'SELECT status, run_at FROM cron_runs WHERE job_type = ? AND target = ?',
  )
    .bind(jobType, target)
    .first<{ status: string; run_at: string }>();
  if (row?.status === 'done') return false;
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

async function finishJob(env: Env, jobType: string, target: string, detail: string, ok: boolean): Promise<void> {
  await env.DB.prepare(
    'UPDATE cron_runs SET status = ?, detail = ?, run_at = ? WHERE job_type = ? AND target = ?',
  )
    .bind(ok ? 'done' : 'failed', detail, isoInBeijing(), jobType, target)
    .run();
}

/** 归档单个自然日：消息 → 上下文+天气 → R2 .log → AI 提炼 → 大小维护 → 刷新记忆缓存。 */
async function archiveOneDay(env: Env, target: string, now: Date): Promise<DailyArchiveResult> {
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
    const rows = await messagesByDate(env, target);

    // 2) 当天上下文 + 天气快照（优先用当天聊天时记录的天气）
    const ctx = await getOrCreateDayContext(env, target);
    const liveWeather = await fetchWeather(env);
    const weather = ctx.weather ?? liveWeather;
    if (weather && !ctx.weather) await attachWeather(env, target, weather);

    // 3) 写存储：chat_logs/YYYY-MM-DD.log（后缀 .log，内容为 JSON）
    await putObject(
      env,
      `chat_logs/${target}.log`,
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

    // 4) AI 提炼当天对话 → 合并进 memory.md（失败不阻断归档）
    let memory = await getMemory(env);
    const before = byteLength(memory);
    let distilled = false;
    let distillCost = 0;
    let usedFallback = false;
    if (rows.length > 0) {
      try {
        const daySummary = await getDaySummaryRaw(env, target).catch(() => null);
        // 主动消息（turn_type='proactive'）标注出来，避免提炼时误当成用户说过的话
        const conversation =
          rows
            .map((m) => {
              if (m.role === 'user') return `用户：${m.content}`;
              return m.turn_type === 'proactive'
                ? `助手（主动发起，用户未回复）：${m.content}`
                : `助手：${m.content}`;
            })
            .join('\n\n') +
          (daySummary?.text ? `\n\n今日摘要（滚动提炼）：${daySummary.text}` : '');
        const summary = await distillDay(env, target, conversation, memory);
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
          console.log(
            `[daily] relation drivers — 消息 ${stats.intimacy.userMessages} 轮 / 天数 ${stats.intimacy.activeDays} / ` +
              `温暖 ${stats.affinity.warmTurns} / 感谢 ${stats.affinity.gratefulCount} / ` +
              `冒犯 ${stats.affinity.offensiveCount} / 冲突 ${stats.affinity.hadConflict}`,
          );
        }
        distillCost += summary.cost;
        if (summary.backend === 'workers-ai') usedFallback = true;
        // 把当天提炼结果写进 context/{date}.json（方便回溯当天要点；失败不影响归档）
        if (summary.text.trim()) {
          try {
            await attachDistillation(env, target, summary.text.trim(), now);
          } catch (e) {
            console.error('[daily] attach distillation to context failed:', e);
          }
        }
      } catch (e) {
        console.error('[daily] distill failed:', e);
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
        console.log(`[daily] emotion settle — ${JSON.stringify(settled.applied)}`);
      }
      await commitEmotionSettle(env, working);
      if (settled.changed || nextMood !== baseVals.mood) {
        console.log(`[daily] emotion settle — ${JSON.stringify(settled.applied)} mood=${nextMood}`);
      }
    } catch (e) {
      console.error('[daily] emotion settle failed:', e);
    }

    // 5) 短期区块到期：先把「近期动态」超过 7 天的条目无损搬进档案，再清理
    try {
      const pruned = pruneTransientSections(memory, target);
      if (pruned.removed > 0) {
        await appendArchiveLines(env, pruned.removedLines);
        const archive = await getArchiveLines(env);
        const preserved = pruned.removedLines.every((line) => archiveHasLine(archive, line));
        if (preserved) {
          memory = pruned.text;
          console.log(`[daily] 近期动态 ${pruned.removed} 条过期条目搬进档案`);
        } else {
          console.error('[daily] 近期动态清理中止：档案未确认写入，保留核心层');
        }
      }
    } catch (e) {
      console.error('[daily] prune transient failed:', e);
    }

    // 5.5) 已完成事项自动归档：「进行中的事项」里标 [已完成] 且过宽限期的 → 移到「共同经历」
    try {
      const archived = archiveCompletedItems(memory, target);
      if (archived.moved > 0) {
        memory = archived.text;
        console.log(`[daily] 已完成事项归档 ${archived.moved} 条：${archived.titles.join('、')}`);
      }
    } catch (e) {
      console.error('[daily] archive completed failed:', e);
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
          console.log(`[daily] 雷区学习 新增 ${entries.length} 条：${acc.promoted.map((p) => p.topic).join('、')}`);
        }
      }
    } catch (e) {
      console.error('[daily] aversion learn failed:', e);
    }

    // 5.7) 质量优先：不再做「合并同类项」。旧实现会把同一分区最旧的两条强行并成一条，
    //      哪怕内容毫无关系，会破坏条目边界和档案检索精度。超限统一走下面的无损分层。

    // 5.8) 分层：核心层超 12KB 时，按「共同经历 → 进行中的事项 → 近期动态」把最旧条目
    //      无损搬进 R2 档案。必须先确认档案里已经有这条，才从 memory 删除；写失败就不动。
    let demotedCount = 0;
    try {
      for (const header of DEMOTE_HEADERS) {
        if (byteLength(memory) <= CORE_TARGET_BYTES) break;
        const demoted = demoteSectionEntries(memory, header, CORE_TARGET_BYTES);
        if (demoted.removed.length === 0) continue;
        await appendArchiveLines(env, demoted.removed);
        const archive = await getArchiveLines(env);
        const preserved = demoted.removed.every((line) => archiveHasLine(archive, line));
        if (!preserved) {
          console.error(`[daily] 分层中止：${header} 有 ${demoted.removed.length} 条未确认写入档案，保留核心层`);
          break;
        }
        memory = demoted.text;
        demotedCount += demoted.removed.length;
        console.log(`[daily] 分层：${demoted.removed.length} 条从 ${header} 搬进记忆档案`);
      }
      if (demotedCount > 0) console.log(`[daily] 分层完成：共 ${demotedCount} 条`);
      if (byteLength(memory) > CORE_TARGET_BYTES) {
        console.warn(`[daily] 核心记忆仍 ${byteLength(memory)}B > ${CORE_TARGET_BYTES}B；已停止压缩/删除，交给注入上限裁剪`);
      }
    } catch (e) {
      console.error('[daily] demote to archive failed:', e);
    }

    // 6) 质量优先：不再做 LLM 压缩，也不直接删除最旧条目。
    //    超过 12KB 只通过“搬档案”降体积；搬不动就保留，注入时再按上限筛选。
    const trimmed = false;

    // 7) 长期不联系时关系缓慢衰减
    try {
      const inactiveDays = await daysSinceLastUserMessage(env, now);
      const decay = applyRelationDecay(memory, inactiveDays);
      if (decay.changed) {
        memory = decay.text;
        console.log(`[daily] relation decay: ${decay.note}`);
      }
    } catch (e) {
      console.error('[daily] relation decay failed:', e);
    }

    // 7) 写回 R2 + 强制刷新 KV 缓存（24h TTL）
    await putMemory(env, memory);
    // 当天已归档，清理滚动摘要（新的一天用新键）
    await env.KV.delete(summaryKey(target)).catch(() => {});
    // 关系状态写入当天上下文（好感度/亲密度 + 综合态度）
    try {
      const relation = parseRelationValues(memory);
      await attachRelation(env, target, buildRelationStatus(relation.affinity, relation.intimacy, relation.mood), now);
    } catch (e) {
      console.error('[daily] attach relation failed:', e);
    }
    const after = byteLength(memory);
    // 提炼/压缩的费用不在 messages 表里，单独记账到 KV，供 /api/usage 汇总
    await addLlmCost(env, target, distillCost);
    const costInfo =
      distillCost > 0
        ? `；提炼费用 ¥${distillCost.toFixed(4)}${usedFallback ? '（部分用 Workers AI 兜底）' : ''}`
        : usedFallback
          ? '；提炼用 Workers AI 兜底'
          : '';
    const detail = `归档 ${rows.length} 条消息；记忆 ${before}→${after} 字节；提炼=${distilled}${costInfo}；裁剪=${trimmed}`;
    await finishJob(env, 'daily_archive', target, detail, true);
    return {
      target,
      messages: rows.length,
      memory_bytes_before: before,
      memory_bytes_after: after,
      distilled,
      trimmed,
      catchup_days: [],
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[daily] archive failed for', target, e);
    await finishJob(env, 'daily_archive', target, msg, false).catch(() => {});
    throw e;
  }
}

/** 每日归档入口：先补跑历史失败日期（最旧优先，≤7 个），再归档前一天。 */
export async function runDailyArchive(env: Env, now: Date): Promise<DailyArchiveResult> {
  // 存储容量检查：主账号接近上限时，把后续写入切换到小号 R2
  await checkStorageCapacity(env).catch((e) => console.error('[storage] capacity check failed:', e));

  // 回填主动消息质量反馈（发出 2 小时后检查用户是否回复）
  await backfillFeedback(env, now).catch((e) => console.error('[feedback] backfill failed:', e));

  // 清理：30 天前的已发送队列记录、过期的 context/images 文件
  await cleanupQueue(env).catch((e) => console.error('[queue] cleanup failed:', e));
  await cleanupStaleObjects(env, now).catch((e) => console.error('[r2] cleanup failed:', e));

  const failed = await env.DB.prepare(
    "SELECT target FROM cron_runs WHERE job_type = 'daily_archive' AND status = 'failed' ORDER BY target ASC LIMIT 7",
  ).all<{ target: string }>();

  const catchup: string[] = [];
  for (const row of failed.results ?? []) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.target)) continue;
    try {
      const r = await archiveOneDay(env, row.target, now);
      catchup.push(`${r.target}(${r.messages}条)`);
    } catch (e) {
      console.error('[daily] catch-up failed for', row.target, e);
    }
  }

  const target = previousDateKey(dateKeyInBeijing(now));
  const main = await archiveOneDay(env, target, now);
  return {
    ...main,
    catchup_days: catchup,
    note: catchup.length ? `补跑失败日期：${catchup.join('、')}；${main.note ?? ''}` : main.note,
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
): { merged: MessageRow[]; expected: number } {
  const map = new Map<number, MessageRow>();
  let expected = 0;
  for (const log of logs) {
    expected += log.messages.length;
    for (const m of log.messages) {
      if (!map.has(m.id)) map.set(m.id, m);
    }
  }
  return { merged: [...map.values()].sort((a, b) => a.id - b.id), expected };
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
        console.error('[monthly] 补归档失败', date, e);
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
    const { merged: all, expected } = mergeDailyLogs(logs);
    if (all.length !== expected) {
      throw new Error(`完整性校验失败：单日日志合计 ${expected} 条，去重后 ${all.length} 条`);
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
    console.error('[monthly] merge failed for', month, e);
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
      console.error('[monthly] catch-up failed for', row.target, e);
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
  if (weather) await attachWeather(env, dateKey, weather).catch((e) => console.error('[context] weather failed:', e));

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
      console.log(`[context] 心情同步 ${relation.mood} → ${mood}（由情绪向量派生）`);
    }

    const finalRelation = parseRelationValues(updatedMemory);
    await attachRelation(
      env,
      dateKey,
      buildRelationStatus(finalRelation.affinity, finalRelation.intimacy, finalRelation.mood),
      now,
    );
  } catch (e) {
    console.error('[context] relation refresh failed:', e);
  }
}
