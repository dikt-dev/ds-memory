/**
 * 管理端路由（/api/admin/*）：手动触发、统计、记忆运维、情感时间线…
 *
 * 从 index.ts 整块搬出来，只为让入口文件回到「装配」的角色。
 * 路由与行为一字未改，路由清单快照（routes.snapshot.json）保证没漏挂。
 */
import type { Hono } from 'hono';
import type { AppEnv } from './types';
import { requireAuth } from './middleware';
import { MEMORY_KV_KEY, getMemory, putMemory } from './memory';
import { ensureLifeDay, lifeNow } from './life/jobs';
import { beijingDateKey, getDayPlan } from './life/state';
import { byteLength, mergeMemoryEntry, parseRelationValues, setRelationValues } from './memory-maintenance';
import { reindexMemory, buildPromptMemoryFor } from './memory-index';
import { listSnapshots, restoreSnapshot } from './memory-snapshot';
import { deleteObject, getObject, headObject, listKeys, putObject } from './storage';
import { MemoryContextStats, MemoryJobStats, backfillMemoryProvenance, embedMemoryChunks, loadMemoryChunks, memoryContextStats, memoryJobStats, replaceMemoryContext, syncArchiveContext, syncRollupSummaries } from './memory-context-store';
import { expandLinkedChunks, expansionBudget, linkAllFacts, linksForMemory } from './memory-links';
import { rankMemoryChunks } from './memory-domain';
import { resolveRecall } from './memory-engine';
import { readEngineMetrics } from './engine-metrics';
import { readRecallSamples, summarizeSamples } from './recall-samples';
import { listActions, markReverted } from './memory-actions';
import { policyTable, type ActionKind } from './policy';
import { loadHealth } from './health';
import { degradationBreakdown, readDegradations, totalDegradations } from './degradations';
import { auditSubjects, suggestRewrite } from './subject-guard';
import { runSelfCheck } from './self-check';
import { runSelfReview } from './self-review';
import { loadVariants, proposeVariant, decideById, rollbackVariant } from './variants';
import { loadPersonaDrift } from './persona-fingerprint';
import { buildFactsDocMarkdown, rebuildFactsDoc } from './memory-doc';
import { listPinnedChunks, setChunkPinned } from './memory-rehearsal';
import { parseMemoryContext } from './memory-domain';
import { applySubjectFixes } from './subject-fix';
import { recordAction } from './memory-actions';
import { dateKeyInBeijing } from './date';
import { backfillEvents, readEventStats } from './memory-events';
import { insertKeepsake, loadKeepsakes, refreshKeepsakesBlock, setKeepsakePinned, setKeepsakeStatus } from './keepsakes';
import { readUsageStats, summarizeUsage } from './usage-stats';
import { getArchiveLines } from './memory-archive';
import { enqueueMemoryJob, runMemoryJobs } from './memory-jobs';
import { applyMemoryProjection, buildMemoryProjection } from './memory-projection';
import { generateRollup, previousPeriods } from './memory-rollups';
import { archiveOneDay, runContextRefresh, runDailyArchive, runMonthlyMerge } from './jobs';
import { analyzeMood } from './mood';
import { mergeMood, needsAiVerification, verifyMoodWithAI } from './mood-ai';
import { currentArchetype, effectiveFacets, facetsOf, listOpenGrievances, loadEmotionState, processEmotionTurn, resetEmotionState, simulateEmotion } from './emotion-context';
import { buildEmotionSnapshot, describeEmotionState } from './emotion-snapshot';
import { explainAttitude } from './attitude-policy';
import { listAffectTimeline, recordAttitudeSnapshot } from './affect-store';
import { getOrCreateDayContext } from './context';
import { readPathStats, readRecentRequests } from './request-log';
import { logError, logWarn } from './error-log';

export function registerAdminRoutes(app: Hono<AppEnv>): void {
// —— 阶段 2/3：手动触发与统计 ——
app.post('/api/admin/memory/refresh', requireAuth, async (c) => {
  // 手动改完 R2 的 memory.md 后，强制丢弃 24h KV 缓存并立即回源重建
  await c.env.KV.delete(MEMORY_KV_KEY).catch(() => {});
  const memory = await getMemory(c.env);
  const entries = (memory.match(/^-\s*\[(?:\d{4}|\d{2})-\d{2}-\d{2}\]/gm) ?? []).length;
  return c.json({ ok: true, bytes: byteLength(memory), entries, empty: !memory.trim() });
});
/** 从 R2 的 memory.md + archive.md 重建 D1 记忆检索索引（幂等）。 */
app.post('/api/admin/memory/reindex', requireAuth, async (c) => {
  const result = await reindexMemory(c.env);
  return c.json({ ok: true, ...result });
});

/**
 * 记忆快照列表：恢复前的"可选清单"。
 * 带上字节数，才能一眼看出哪天的记忆被写残了（正常约 12KB）。
 */
app.get('/api/admin/memory/snapshots', requireAuth, async (c) => {
  const snapshots = await listSnapshots(c.env);
  const withSize = await Promise.all(
    snapshots.map(async (s) => {
      const head = await headObject(c.env, s.key).catch(() => null);
      return { date: s.date, key: s.key, bytes: head?.size ?? null };
    }),
  );
  return c.json({ ok: true, current: byteLength(await getMemory(c.env)), snapshots: withSize });
});

/**
 * 从快照恢复记忆。破坏性操作，必须带 confirm:true。
 * 恢复成功后重建索引与 Memory Context，链路和归档写回完全一致。
 */
app.post('/api/admin/memory/restore', requireAuth, async (c) => {
  const body = (await c.req.json().catch(() => null)) as
    | { date?: unknown; confirm?: unknown }
    | null;
  const date = typeof body?.date === 'string' ? body.date.trim() : '';
  if (body?.confirm !== true) {
    return c.json({ error: 'confirm:true required（会覆盖当前记忆）' }, 400);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return c.json({ error: 'date(YYYY-MM-DD) required' }, 400);
  const result = await restoreSnapshot(c.env, date);
  if (!result.restored) return c.json({ ok: false, ...result }, 409);
  let reindexed: Awaited<ReturnType<typeof reindexMemory>> | null = null;
  let context: Awaited<ReturnType<typeof replaceMemoryContext>> | null = null;
  try {
    reindexed = await reindexMemory(c.env);
  } catch (e) {
    logError('[memory] restore reindex failed:', e);
  }
  try {
    context = await replaceMemoryContext(c.env, await getMemory(c.env), 'memory');
  } catch (e) {
    logError('[memory] restore context failed:', e);
  }
  return c.json({ ok: true, ...result, reindexed, context });
});
/** Phase 2：查看 Memory Context 表规模。 */
app.get('/api/admin/memory/context-stats', requireAuth, async (c) => {
  return c.json({ ok: true, ...(await memoryContextStats(c.env)) });
});
/** 来源追溯：查看某条事实/事件直接关联和来源消息 id。 */
app.get('/api/admin/memory/links', requireAuth, async (c) => {
  const type = c.req.query('type') === 'event' ? 'event' : 'fact';
  const id = (c.req.query('id') ?? '').trim();
  if (!id) return c.json({ error: 'id required' }, 400);
  return c.json({ ok: true, type, id, ...(await linksForMemory(c.env, type, id)) });
});

/** 修复历史提炼结果：把 context/日期.json 里漏合并的 distilled_summary 重新并入 memory.md。 */
app.post('/api/admin/memory/replay-distill', requireAuth, async (c) => {
  const body = (await c.req.json().catch(() => null)) as { dates?: unknown } | null;
  const dates = Array.isArray(body?.dates)
    ? body.dates.filter((d): d is string => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d))
    : [];
  if (dates.length === 0) return c.json({ error: 'dates required' }, 400);
  let memory = await getMemory(c.env);
  const applied: string[] = [];
  for (const date of dates) {
    const obj = await getObject(c.env, `context/${date}.json`).catch(() => null);
    if (!obj) continue;
    try {
      const parsed = JSON.parse(await obj.text()) as { distilled_summary?: unknown };
      const summary = typeof parsed.distilled_summary === 'string' ? parsed.distilled_summary : '';
      if (!summary.trim()) continue;
      const next = mergeMemoryEntry(memory, summary, date);
      if (next !== memory) {
        memory = next;
        applied.push(date);
      }
    } catch (e) {
      logError('[memory] replay distill failed:', date, e);
    }
  }
  if (applied.length > 0) {
    await putMemory(c.env, memory);
    await replaceMemoryContext(c.env, memory, 'memory').catch(() => {});
    // 重建 chunks 后必须补索引和向量，否则 replay 会留下 no_vec。
    await reindexMemory(c.env).catch((e) => logError('[memory] replay reindex failed:', e));
    await embedMemoryChunks(c.env, 200).catch((e) =>
      logError('[memory] replay embed failed:', e),
    );
  }
  return c.json({
    ok: true,
    applied,
    bytes: byteLength(memory),
  });
});

/** 手动补齐存量事实关联；日常归档只对新事实增量建链。 */
app.post('/api/admin/memory/link-all', requireAuth, async (c) => {
  const linked = await linkAllFacts(c.env);
  return c.json({ ok: true, linked });
});

/** 回归调试：只读召回结果，不写记忆、不发模型。 */
app.get('/api/admin/memory/recall', requireAuth, async (c) => {
  const q = (c.req.query('q') ?? '').trim().slice(0, 500);
  if (!q) return c.json({ error: 'q required' }, 400);
  const chunks = await loadMemoryChunks(c.env);
  const picked = rankMemoryChunks(q, chunks, 10);
  const expanded = await expandLinkedChunks(c.env, picked, expansionBudget(picked.length));
  // compare=1：同一句话按**生产链路**同时跑 legacy 与 next（含门控、选择器、封顶），
  // 给评估集对照用。直接调 recallMemoryForChat 会绕过门控，"在吗"这种就会假性翻旧账。
  if (c.req.query('compare') === '1') {
    const r = await resolveRecall(c.env, {
      query: q,
      mode: 'shadow',
      channel: 'web',
      requestId: 'eval-compare',
    });
    const countItems = (text: string) =>
      text.split('\n').filter((line: string) => line.trimStart().startsWith('- ')).length;
    return c.json({
      ok: true,
      query: q,
      skipped: r.skipped,
      timedOut: r.timedOut,
      ms: r.ms,
      legacy: { items: countItems(r.legacyText), text: r.legacyText },
      next: { items: countItems(r.nextText), text: r.nextText },
    });
  }
  return c.json({
    ok: true,
    query: q,
    picked: picked.length,
    linked: Math.max(0, expanded.length - picked.length),
    items: expanded.map((m) => ({
      id: m.id,
      source: m.source,
      date: m.date,
      content: m.content,
    })),
  });
});

/** Phase 5 观察：按天读取 shadow/next 指标（不记录正文）。 */
app.get('/api/admin/engine-metrics', requireAuth, async (c) => {
  const days = Math.min(30, Math.max(1, Number(c.req.query('days') ?? 7) || 7));
  const rows = await readEngineMetrics(c.env, days);
  return c.json({ ok: true, days, rows });
});

/** 召回分段耗时：p50/p95 与各段占比（只读，不含正文）。 */
app.get('/api/admin/recall-samples', requireAuth, async (c) => {
  const days = Math.min(14, Math.max(1, Number(c.req.query('days') ?? 3) || 3));
  const rows = await readRecallSamples(c.env, days);
  return c.json({ ok: true, days, samples: rows.length, summary: summarizeSamples(rows) });
});

/** 事件记忆（v2 阶段 A，影子）：看影子数据攒了多少。 */
app.get('/api/admin/memory/events', requireAuth, async (c) => {
  const days = Math.min(30, Math.max(1, Number(c.req.query('days') ?? 7) || 7));
  return c.json({ ok: true, days, stats: await readEventStats(c.env, days) });
});

/** 事件记忆（v2 阶段 A，影子）：把最近几天整理成事件。只写不读，需 confirm=1。 */
app.post('/api/admin/memory/events/backfill', requireAuth, async (c) => {
  if (c.req.query('confirm') !== '1') {
    return c.json({ ok: false, error: 'need confirm=1（会调用模型产生费用）' }, 400);
  }
  const days = Math.min(30, Math.max(1, Number(c.req.query('days') ?? 3) || 3));
  const maxEvents = Math.min(200, Math.max(1, Number(c.req.query('max') ?? 30) || 30));
  const result = await backfillEvents(c.env, { days, maxEvents });
  return c.json({ ok: true, ...result });
});

/** 自主动作审计：她做过什么、为什么、能不能撤（ADR-001 S2）。 */
app.get('/api/admin/memory/actions', requireAuth, async (c) => {
  const limit = Number(c.req.query('limit') ?? 50) || 50;
  const kind = c.req.query('kind') as ActionKind | undefined;
  const items = await listActions(c.env, { limit, kind: kind || undefined });
  return c.json({ ok: true, items, policy: policyTable() });
});

/** 撤销一笔自主动作（只标记，回滚由具体动作实现）。 */
app.post('/api/admin/memory/actions/:id/revert', requireAuth, async (c) => {
  const id = Number(c.req.param('id')) || 0;
  if (id <= 0) return c.json({ ok: false, error: 'bad id' }, 400);
  const ok = await markReverted(c.env, id, id);
  return c.json({ ok, reverted: ok });
});

/** 铭记：列表（默认只看已通过；pending=1 看候选）。 */
app.get('/api/admin/memory/keepsakes', requireAuth, async (c) => {
  const status = c.req.query('status');
  const items = await loadKeepsakes(
    c.env,
    status === 'pending' || status === 'approved' || status === 'rejected' ? status : undefined,
  );
  return c.json({ ok: true, items });
});

/** 铭记：手动新增（source=manual，直接通过）。 */
app.post('/api/admin/memory/keepsakes', requireAuth, async (c) => {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body.title !== 'string') {
    return c.json({ ok: false, error: 'need title' }, 400);
  }
  const happenedAt =
    typeof body.happened_at === 'number'
      ? body.happened_at
      : typeof body.happened_at === 'string'
        ? Date.parse(body.happened_at)
        : Date.now();
  const outcome = await insertKeepsake(c.env, {
    kind: (typeof body.kind === 'string' ? body.kind : 'custom') as never,
    tone: (typeof body.tone === 'string' ? body.tone : 'warm') as never,
    title: body.title,
    detail: typeof body.detail === 'string' ? body.detail : '',
    happened_at: Number.isFinite(happenedAt) ? happenedAt : Date.now(),
    source: 'manual',
    status: 'approved',
    evidence: typeof body.evidence === 'string' ? body.evidence : '',
  });
  if (outcome !== 'inserted') return c.json({ ok: false, outcome }, 409);
  await refreshKeepsakesBlock(c.env);
  return c.json({ ok: true, outcome });
});

/** 铭记：审核（approved / rejected）。 */
app.post('/api/admin/memory/keepsakes/:id/status', requireAuth, async (c) => {
  const body = (await c.req.json().catch(() => null)) as { status?: string } | null;
  const status = body?.status;
  if (status !== 'approved' && status !== 'rejected' && status !== 'pending') {
    return c.json({ ok: false, error: 'bad status' }, 400);
  }
  const id = c.req.param('id') ?? '';
  const ok = await setKeepsakeStatus(c.env, id, status);
  if (ok) await refreshKeepsakesBlock(c.env);
  return c.json({ ok });
});

/** 铭记：放回/移出常驻注入。 */
app.post('/api/admin/memory/keepsakes/:id/pin', requireAuth, async (c) => {
  const body = (await c.req.json().catch(() => null)) as { pinned?: number } | null;
  const pinned = body?.pinned === 0 ? 0 : 1;
  const id = c.req.param('id') ?? '';
  const ok = await setKeepsakePinned(c.env, id, pinned);
  if (ok) await refreshKeepsakesBlock(c.env);
  return c.json({ ok, pinned });
});

/** 成本看板：按天聚合 token / 费用 / 缓存命中率（只读）。 */
app.get('/api/admin/cost', requireAuth, async (c) => {
  const days = Math.min(30, Math.max(1, Number(c.req.query('days') ?? 7) || 7));
  const rows = await readUsageStats(c.env, days);
  return c.json({ ok: true, days, rows, summary: summarizeUsage(rows, days) });
});

/** Phase 5 预检：只读检查迁移/开关/密钥，不做任何写入。 */
app.get('/api/admin/readiness', requireAuth, async (c) => {
  const tables = [
    'runtime_state',
    'auth_revocations',
    'memory_facts',
    'memory_events',
    'memory_summaries',
    'memory_chunks',
    'memory_jobs',
    'affect_events',
    'attitude_snapshots',
    'engine_metrics',
    'chat_usage',
    'memory_keepsakes',
  ];
  const checks: Record<string, string> = {};
  for (const table of tables) {
    try {
      await c.env.DB.prepare(`SELECT 1 FROM ${table} LIMIT 1`).first();
      checks[table] = 'ok';
    } catch {
      checks[table] = 'missing';
    }
  }
  let memoryBytes = 0;
  try {
    memoryBytes = byteLength(await getMemory(c.env));
  } catch {
    /* ignore */
  }
  let context: MemoryContextStats | null = null;
  try {
    context = await memoryContextStats(c.env);
  } catch {
    context = null;
  }
  let jobs: MemoryJobStats | null = null;
  try {
    jobs = await memoryJobStats(c.env);
  } catch {
    jobs = null;
  }
  const missing = tables.filter((t) => checks[t] !== 'ok');
  const warnings: string[] = [];
  if (!c.env.AUTH_SECRET) warnings.push('AUTH_SECRET 未设置（当前会回退口令哈希）');
  if ((c.env.MEMORY_ENGINE ?? 'legacy') === 'legacy') warnings.push('MEMORY_ENGINE=legacy');
  if ((c.env.AFFECT_ENGINE ?? 'legacy') === 'legacy') warnings.push('AFFECT_ENGINE=legacy');
  if (context && context.embedded === 0) warnings.push('memory_chunks 尚无向量，当前走关键词');
  const ready = missing.length === 0 && Boolean(c.env.AUTH_SECRET || c.env.ACCESS_PASSWORD_HASH);
  return c.json(
    {
      ok: ready,
      ready,
      checks,
      missing,
      auth_mode: c.env.AUTH_MODE ?? 'signed',
      memory_engine: c.env.MEMORY_ENGINE ?? 'legacy',
      affect_engine: c.env.AFFECT_ENGINE ?? 'legacy',
      memory_engine_qq: c.env.MEMORY_ENGINE_QQ ?? c.env.MEMORY_ENGINE ?? 'legacy',
      memory_engine_mobile: c.env.MEMORY_ENGINE_MOBILE ?? c.env.MEMORY_ENGINE ?? 'legacy',
      memory_engine_web: c.env.MEMORY_ENGINE_WEB ?? c.env.MEMORY_ENGINE ?? 'legacy',
      affect_engine_qq: c.env.AFFECT_ENGINE_QQ ?? c.env.AFFECT_ENGINE ?? 'legacy',
      affect_engine_mobile: c.env.AFFECT_ENGINE_MOBILE ?? c.env.AFFECT_ENGINE ?? 'legacy',
      affect_engine_web: c.env.AFFECT_ENGINE_WEB ?? c.env.AFFECT_ENGINE ?? 'legacy',
      proactive_engine: c.env.PROACTIVE_ENGINE ?? 'legacy',
      proactive_delivery: c.env.PROACTIVE_DELIVERY ?? 'events',
      auth_secret_configured: Boolean(c.env.AUTH_SECRET),
      memory_bytes: memoryBytes,
      context,
      jobs,
      warnings,
    },
    ready ? 200 : 503,
  );
});
/** facts.md：只读投影（不进提示词）。GET 预览，POST 重建。 */
app.get('/api/admin/memory/facts-doc', requireAuth, async (c) => {
  const { markdown, facts } = await buildFactsDocMarkdown(c.env, dateKeyInBeijing(new Date()));
  return c.json({ ok: true, facts, markdown });
});

app.post('/api/admin/memory/facts-doc', requireAuth, async (c) => {
  const result = await rebuildFactsDoc(c.env, dateKeyInBeijing(new Date()));
  return c.json({ ok: true, ...result });
});

/** 人格指纹：近 7 天 vs 前 7 天，她是不是还是她。 */
app.get('/api/admin/memory/persona-drift', requireAuth, async (c) => {
  const result = await loadPersonaDrift(c.env);
  return c.json({ ok: true, ...result });
});

/** B 档变体：列表。 */
app.get('/api/admin/memory/variants', requireAuth, async (c) => {
  const items = await loadVariants(c.env);
  return c.json({ ok: true, items });
});

/** B 档变体：提交候选（只登记，不上线；必须带 intent + evidence）。 */
app.post('/api/admin/memory/variants', requireAuth, async (c) => {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body.kind !== 'string' || typeof body.target !== 'string') {
    return c.json({ ok: false, error: 'need kind + target' }, 400);
  }
  if (body.kind !== 'prompt' && body.kind !== 'extractor' && body.kind !== 'retrieval') {
    return c.json({ ok: false, error: 'bad kind' }, 400);
  }
  try {
    const variant = await proposeVariant(c.env, {
      kind: body.kind,
      target: body.target,
      change: typeof body.change === 'string' ? body.change : '',
      intent: typeof body.intent === 'string' ? body.intent : '',
      evidence: Array.isArray(body.evidence) ? body.evidence.map((e) => String(e)) : [],
    });
    return c.json({ ok: true, variant });
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 400);
  }
});

/** B 档变体：用评估数据裁决。 */
app.post('/api/admin/memory/variants/:id/decide', requireAuth, async (c) => {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const baseline = body?.baseline as Record<string, number> | undefined;
  const candidate = body?.candidate as Record<string, number> | undefined;
  const toMetrics = (m: Record<string, number> | undefined) => ({
    samples: Number(m?.samples ?? 0),
    hitRate: Number(m?.hitRate ?? 0),
    avgItems: Number(m?.avgItems ?? 0),
    falsePositiveRate: Number(m?.falsePositiveRate ?? 0),
  });
  if (!baseline || !candidate) return c.json({ ok: false, error: 'need baseline + candidate' }, 400);
  const result = await decideById(c.env, c.req.param('id') ?? '', toMetrics(baseline), toMetrics(candidate));
  return c.json({ ok: result.ok, reason: result.reason, variant: result.variant });
});

/** B 档变体：回滚。 */
app.post('/api/admin/memory/variants/:id/rollback', requireAuth, async (c) => {
  const body = (await c.req.json().catch(() => null)) as { reason?: string } | null;
  const ok = await rollbackVariant(c.env, c.req.param('id') ?? '', body?.reason ?? 'manual');
  return c.json({ ok });
});

/** 自审：GET 取当天报告；POST?confirm=1 立即跑一次（只在 A 档内动作）。 */
app.get('/api/admin/memory/self-review', requireAuth, async (c) => {
  const date = c.req.query('date') ?? dateKeyInBeijing(new Date());
  const res = await getObject(c.env, `memory/self-review/${date}.json`).catch(() => null);
  if (!res) return c.json({ ok: false, error: 'no report for that date' }, 404);
  return c.json({ ok: true, report: JSON.parse(await res.text()) });
});

app.post('/api/admin/memory/self-review', requireAuth, async (c) => {
  if (c.req.query('confirm') !== '1') {
    return c.json({ ok: false, error: 'need confirm=1（会调用模型并可能改动片段重要度）' }, 400);
  }
  const report = await runSelfReview(c.env);
  return c.json({ ok: true, report });
});

/** 每夜自检：引文回查 / 孤儿 / 断链，报告写 R2；POST 可立即跑一次。 */
app.get('/api/admin/memory/self-check', requireAuth, async (c) => {
  const res = await getObject(c.env, `memory/self-check/${c.req.query('date') ?? ''}.json`).catch(() => null);
  if (!res) return c.json({ ok: false, error: 'no report for that date' }, 404);
  return c.json({ ok: true, report: JSON.parse(await res.text()) });
});

app.post('/api/admin/memory/self-check', requireAuth, async (c) => {
  const report = await runSelfCheck(c.env);
  return c.json({ ok: true, report });
});

/** 记忆健康分：判据全是外部事实（召回命中、失忆抱怨、延迟），不由模型自评。 */
/** 读取 memory.md 原文（排查用，只读）。 */
app.get('/api/admin/memory/raw', requireAuth, async (c) => {
  const text = await getMemory(c.env);
  return c.json({ ok: true, bytes: byteLength(text), text });
});

/**
 * 一次性修补记忆主体（2026-10-31）。
 *
 * 不是通用记忆编辑器：只做两件事——给"有动作没主体"的条目补「用户」，
 * 以及替换人工审过的整行。改前先备份原文到 R2，改动记进 memory_actions。
 */
app.post('/api/admin/memory/subject-fix', requireAuth, async (c) => {
  const preview = c.req.query('dry') === '1';
  if (!preview && c.req.query('confirm') !== '1') {
    return c.json({ ok: false, error: '需要 confirm=1 才会写记忆（只看方案加 dry=1）' }, 400);
  }
  const before = await getMemory(c.env);
  if (!before.trim()) return c.json({ ok: false, error: '当前没有记忆文件' }, 400);
  const { text: after, changes } = applySubjectFixes(before);
  if (changes.length === 0) return c.json({ ok: true, applied: 0, changes: [] });
  if (preview) return c.json({ ok: true, applied: 0, preview: true, changes });

  // 1) 原文备份：改坏了能整份回滚
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupKey = `memory/subject-fix/${stamp}.md`;
  await putObject(c.env, backupKey, before, { contentType: 'text/markdown' }).catch(() => {});

  // 2) 写回（写闸口 + 读回校验都在 putMemory 里）
  const written = await putMemory(c.env, after, 'human');
  if (!written) return c.json({ ok: false, error: '写入校验失败，已放弃本次修补', backupKey }, 500);

  // 3) 审计：谁改的、改了什么、怎么回滚
  await recordAction(c.env, {
    actor: 'human',
    kind: 'memory.write',
    intent: '修正记忆主体：把「用户做的事被记成她做的」条目补上主体',
    evidence: [backupKey],
    diff: changes.map((x) => `- ${x.from}\n+ ${x.to}`).join('\n').slice(0, 4000),
    before: `${changes.length} 条主体不明`,
    after: `${changes.length} 条已补主体`,
    revertible: true,
  }, Date.now()).catch(() => {});

  // 4) 派生数据重建：facts/chunks 由 memory.md 解析而来，不重建就对不上
  const rebuild = await replaceMemoryContext(c.env, after, 'legacy').catch(() => null);
  await rebuildFactsDoc(c.env).catch(() => {});

  return c.json({ ok: true, applied: changes.length, backupKey, changes, rebuild });
});

/**
 * 生活系统：生成/查看某一天的日程（排查用）。
 *
 * 线上没有 wrangler tail，cron 又只能等 04:00，所以留一个手动入口：
 * GET ?date=2026-11-01 生成并返回当天计划，失败会直接看到原因。
 */
app.post('/api/admin/life/day', requireAuth, async (c) => {
  const dateKey = c.req.query('date') || beijingDateKey();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
    return c.json({ ok: false, error: 'date 要写成 YYYY-MM-DD' }, 400);
  }
  const result = await ensureLifeDay(c.env, dateKey);
  const saved = await getDayPlan(c.env, dateKey);
  return c.json({
    ok: true,
    ...result,
    day: saved?.day ?? null,
    activities: saved?.activities ?? [],
  });
});

app.get('/api/admin/life/now', requireAuth, async (c) => {
  const status = await lifeNow(c.env);
  return c.json({ ok: true, ...status });
});

/**
 * 往某个分区里追加一行（幂等，按关键词去重）。
 *
 * 场景：人设里缺一个字段（比如「样貌」），而现有维护流程只会压缩/提炼，
 * 不会凭空长出一条。这里给一个最小的、可审计的写入口：
 * 备份原文 → 写闸口写入 → 记 memory_actions → 重建派生数据。
 */
app.post('/api/admin/memory/section-line', requireAuth, async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    section?: string;
    line?: string;
    keyword?: string;
    confirm?: boolean;
  } | null;
  const section = String(body?.section ?? '').trim();
  const line = String(body?.line ?? '').trim();
  const keyword = String(body?.keyword ?? section).trim();
  if (!section || !line) return c.json({ ok: false, error: '需要 section 和 line' }, 400);
  if (!section.startsWith('## ')) return c.json({ ok: false, error: 'section 要写成 「## 分区名」' }, 400);

  const before = await getMemory(c.env);
  if (!before.trim()) return c.json({ ok: false, error: '当前没有记忆文件' }, 400);
  const lines = before.split('\n');
  const head = lines.findIndex((x) => x.trim() === section);
  if (head < 0) return c.json({ ok: false, error: `记忆里没有分区 ${section}` }, 404);
  let tail = lines.findIndex((x, i) => i > head && x.startsWith('## '));
  if (tail < 0) tail = lines.length;
  const inSection = lines.slice(head + 1, tail);
  if (inSection.some((x) => x.includes(keyword) && x.includes(line.slice(0, 8)))) {
    return c.json({ ok: true, applied: 0, reason: '已经有这一行了' });
  }
  if (!body?.confirm) return c.json({ ok: true, preview: true, section, line });

  const after = [...lines.slice(0, head + 1), line, ...lines.slice(head + 1)].join('\n');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupKey = `memory/section-line/${stamp}.md`;
  await putObject(c.env, backupKey, before, { contentType: 'text/markdown' }).catch(() => {});
  const written = await putMemory(c.env, after, 'human');
  if (!written) return c.json({ ok: false, error: '写入校验失败，已放弃', backupKey }, 500);
  await recordAction(c.env, {
    actor: 'human',
    kind: 'memory.write',
    intent: `在「${section.replace('## ', '')}」补一行：${line.slice(0, 40)}`,
    evidence: [backupKey],
    diff: `+ ${line}`,
    before: `${byteLength(before)} 字节`,
    after: `${byteLength(after)} 字节`,
    revertible: true,
  }, Date.now()).catch(() => {});
  const rebuild = await replaceMemoryContext(c.env, after, 'legacy').catch(() => null);
  await rebuildFactsDoc(c.env).catch(() => {});
  return c.json({ ok: true, applied: 1, backupKey, rebuild });
});

/**
 * 事实对账：把「memory.md 里已经没有、但库里还活着」的投影事实标成失效。
 *
 * 场景：条目被改写（如补主体）后，旧版本的行还在 active，facts.md 里就出现新旧两份。
 * 只处理 origin=memory/legacy（这两个来源是 memory.md 的投影）；
 * conversation 是用户原话抽出来的，没出现在 memory.md 也照样有效，不动。
 */
app.post('/api/admin/memory/reconcile-facts', requireAuth, async (c) => {
  if (c.req.query('confirm') !== '1') {
    return c.json({ ok: false, error: '需要 confirm=1' }, 400);
  }
  const text = await getMemory(c.env);
  const live = new Set(parseMemoryContext(text).facts.map((f) => f.content));
  const rows = await c.env.DB.prepare(
    `SELECT id, content FROM memory_facts
     WHERE origin IN ('memory', 'legacy') AND (valid_to IS NULL OR valid_to = '') LIMIT 2000`,
  ).all<{ id: string; content: string }>();
  const stale = (rows.results ?? []).filter((r) => !live.has(r.content));
  if (stale.length === 0) return c.json({ ok: true, expired: 0 });

  const today = dateKeyInBeijing(new Date());
  const nowMs = Date.now();
  await c.env.DB.batch(
    stale.map((r) =>
      c.env.DB.prepare(
        'UPDATE memory_facts SET valid_to = ?, updated_at = ? WHERE id = ? AND (valid_to IS NULL OR valid_to = \'\')',
      ).bind(today, nowMs, r.id),
    ),
  );
  await rebuildFactsDoc(c.env).catch(() => {});
  await recordAction(c.env, {
    actor: 'human',
    kind: 'fact.expire',
    intent: '改写主体后清理旧版本的投影事实（memory.md 里已不存在）',
    evidence: stale.slice(0, 10).map((r) => 'fact:' + r.id),
    diff: `失效事实 ${stale.length} 条（memory.md 里已不存在）`,
    before: `活跃投影事实 ${rows.results?.length ?? 0} 条`,
    after: `有效 ${live.size} 条`,
    revertible: true,
  }, nowMs).catch(() => {});

  return c.json({
    ok: true,
    expiredFacts: stale.length,
    sample: stale.slice(0, 5).map((r) => r.content.slice(0, 60)),
  });
});

/** 铭记锁：当前永不淡忘的条目。 */
app.get('/api/admin/memory/pinned', requireAuth, async (c) => {
  const rows = await listPinnedChunks(c.env);
  return c.json({ ok: true, total: rows.length, pinned: rows });
});

/** 上锁 / 解锁一条记忆（铭记 = 永不淡忘，不是删除的反面）。 */
app.post('/api/admin/memory/pin', requireAuth, async (c) => {
  const body = (await c.req.json().catch(() => null)) as { id?: unknown; pinned?: unknown } | null;
  const id = typeof body?.id === 'string' ? body.id.trim() : '';
  if (!id) return c.json({ ok: false, error: 'id required' }, 400);
  const pinned = body?.pinned !== false;
  const changed = await setChunkPinned(c.env, id, pinned);
  if (!changed) return c.json({ ok: false, error: 'chunk not found' }, 404);
  await recordAction(c.env, {
    actor: 'human',
    kind: 'memory.write',
    intent: pinned ? '给一条记忆上铭记锁（永不淡忘）' : '解除铭记锁',
    evidence: [id],
    diff: pinned ? 'pinned=1' : 'pinned=0',
    before: pinned ? '可淡忘' : '铭记中',
    after: pinned ? '铭记中' : '可淡忘',
    revertible: true,
  }, Date.now()).catch(() => {});
  return c.json({ ok: true, id, pinned });
});

/** 记忆主体审计：把「用户做的事被记成她做的」条目挑出来，只报告不改。 */
app.get('/api/admin/memory/subject-audit', requireAuth, async (c) => {
  const text = await getMemory(c.env).catch(() => '');
  const issues = auditSubjects(text).map((i) => ({ ...i, suggestion: suggestRewrite(i.line) }));
  return c.json({ ok: true, total: issues.length, issues });
});

/** 静默降级分布：健康分里扣了分，这里看是哪一块在坏。 */
app.get('/api/admin/memory/degradations', requireAuth, async (c) => {
  const days = Number(c.req.query('days') ?? 7) || 7;
  const rows = await readDegradations(c.env, days);
  return c.json({
    days: Math.min(30, Math.max(1, Math.floor(days))),
    total: totalDegradations(rows),
    breakdown: degradationBreakdown(rows),
    rows,
  });
});

app.get('/api/admin/memory/health', requireAuth, async (c) => {
  const days = Number(c.req.query('days') ?? 7) || 7;
  const result = await loadHealth(c.env, days);
  return c.json({ ok: true, ...result });
});

/** 提示词记忆预览：切 evidence 模式前后到底带了多少（不落库、不改记忆）。 */
app.get('/api/admin/memory/prompt-preview', requireAuth, async (c) => {
  const memory = await getMemory(c.env);
  const promptMemory = buildPromptMemoryFor(memory, c.env);
  const sections = (text: string) =>
    text.split('\n').filter((line) => line.startsWith('## ')).map((line) => line.slice(3).trim());
  return c.json({
    ok: true,
    mode: promptMemory.evidence ? 'evidence' : promptMemory.mode,
    memoryBytes: new TextEncoder().encode(memory).byteLength,
    promptBytes: new TextEncoder().encode(promptMemory.text).byteLength,
    sectionsInPrompt: sections(promptMemory.text),
    sectionsInMemory: sections(memory),
  });
});

/** Phase 2：从 memory.md 重建 facts/events/chunks（幂等）。 */
app.post('/api/admin/memory/rebuild-context', requireAuth, async (c) => {
  const memory = await getMemory(c.env);
  const result = await replaceMemoryContext(c.env, memory, 'memory');
  return c.json({ ok: true, ...result });
});
/** Phase 2B：同步周/月摘要到 Memory Context。 */
app.post('/api/admin/memory/sync-summaries', requireAuth, async (c) => {
  const summaries = await syncRollupSummaries(c.env);
  return c.json({ ok: true, summaries });
});
/** Phase 2B：把 archive.md 的旧事导入 Memory Context。 */
app.post('/api/admin/memory/sync-archive', requireAuth, async (c) => {
  const lines = await getArchiveLines(c.env);
  const archived = await syncArchiveContext(c.env, lines);
  return c.json({ ok: true, archived });
});
/** Phase 4：给 chunk 补向量（bge-m3），失败自动回退关键词。 */
app.post('/api/admin/memory/embed', requireAuth, async (c) => {
  const body = (await c.req.json().catch(() => null)) as { limit?: unknown } | null;
  const limit = Math.min(200, Math.max(1, Number(body?.limit ?? 64) || 64));
  const embedded = await embedMemoryChunks(c.env, limit);
  return c.json({ ok: true, embedded });
});
/** Phase 2B：用消息内容回填事实来源（近似回溯，最多 5 条/事实）。 */
app.post('/api/admin/memory/backfill-provenance', requireAuth, async (c) => {
  try {
    const linked = await backfillMemoryProvenance(c.env);
    return c.json({ ok: true, linked });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
/** Phase 2B：从最近用户消息抽取显式事实（入队并立即跑 1 个）。 */
app.post('/api/admin/memory/extract', requireAuth, async (c) => {
  const id = await enqueueMemoryJob(c.env, 'extract_conversation', 'recent');
  const result = await runMemoryJobs(c.env, new Date(), 1);
  return c.json({ ok: true, id, ...result });
});
/** Phase 2B：手动处理 queued 记忆任务。 */
app.post('/api/admin/memory/jobs/run', requireAuth, async (c) => {
  const body = (await c.req.json().catch(() => null)) as { limit?: unknown } | null;
  const limit = Math.min(10, Math.max(1, Number(body?.limit ?? 3) || 3));
  const result = await runMemoryJobs(c.env, new Date(), limit);
  return c.json({ ok: true, ...result });
});
/** Phase 2B：任务队列状态。 */
app.get('/api/admin/memory/jobs', requireAuth, async (c) => {
  return c.json({ ok: true, ...(await memoryJobStats(c.env)) });
});
/** Phase 2B：投影预览（只读，不写回 memory.md）。 */
app.get('/api/admin/memory/projection', requireAuth, async (c) => {
  const { parsed, projection } = await buildMemoryProjection(c.env);
  return c.json({
    ok: true,
    bytes: byteLength(projection),
    facts: parsed.facts.length,
    events: parsed.events.length,
    preview: projection.length > 4000 ? `${projection.slice(0, 4000)}\n…` : projection,
  });
});
/** Phase 2B：投影写回 + 旧文件备份。必须显式 confirm，默认不自动跑。 */
app.post('/api/admin/memory/project', requireAuth, async (c) => {
  const body = (await c.req.json().catch(() => null)) as { confirm?: unknown } | null;
  if (body?.confirm !== true) {
    return c.json({ error: '需要 body.confirm=true 才会写回 memory.md' }, 400);
  }
  const result = await applyMemoryProjection(c.env);
  return c.json({ ok: true, ...result });
});
/** 把一条重建任务放入队列（异步；供 cron/手动调用）。 */
app.post('/api/admin/memory/enqueue-rebuild', requireAuth, async (c) => {
  const id = await enqueueMemoryJob(c.env, 'rebuild_context', 'memory.md');
  return c.json({ ok: true, id });
});
/** 合并版：刷新 memory KV 缓存 + 重建检索索引（改完 R2 文件后一键调用）。 */
app.post('/api/admin/memory/reload', requireAuth, async (c) => {
  await c.env.KV.delete(MEMORY_KV_KEY).catch(() => {});
  const memory = await getMemory(c.env);
  const idx = await reindexMemory(c.env);
  return c.json({
    ok: true,
    bytes: byteLength(memory),
    entries: idx.entries,
    withVec: idx.withVec,
    errors: idx.errors,
  });
});
/** 手动生成周/月摘要：body { level?: 'week'|'month', period?: 'YYYY-MM-DD' | 'YYYY-MM' }。 */
app.post('/api/admin/memory/rollup', requireAuth, async (c) => {
  const body = await c.req.json().catch(() => null);
  const level = body?.level === 'month' ? 'month' : 'week';
  const prev = previousPeriods(dateKeyInBeijing(new Date()));
  const period =
    typeof body?.period === 'string' && body.period
      ? body.period
      : level === 'month'
        ? prev.month
        : prev.week;
  const rollup = await generateRollup(c.env, level, period);
  return c.json({ ok: true, level, period, rollup });
});
/** 危险操作：清空 D1 全部业务表 + R2 全部对象（主/小号）+ 记忆相关 KV，仅测试期使用。 */
app.post('/api/admin/wipe-data', requireAuth, async (c) => {
  const tables = [
    'messages',
    'proactive_feedback',
    'proactive_log',
    'proactive_queue',
    'cron_runs',
    'memory_entries',
    'memory_rollups',
    'runtime_state',
    'auth_revocations',
  ];
  const d1 = { tables: 0, rows: 0 };
  for (const t of tables) {
    const r = await c.env.DB.prepare(`DELETE FROM ${t}`).run();
    d1.tables += 1;
    d1.rows += r.meta.changes ?? 0;
  }
  const keys = await listKeys(c.env, '');
  let r2 = 0;
  for (const k of keys) {
    await deleteObject(c.env, k).catch(() => {});
    r2 += 1;
  }
  const kvKeys = [
    MEMORY_KV_KEY,
    'archive:cache',
    'memo:24h',
    'memo:lock',
    'profile:user',
    'profile:dirty',
    'proactive:heartbeat',
    'proactive:offline_alert',
    'proactive:paused_until',
    'files:recent',
    `summary:${dateKeyInBeijing(new Date())}`,
    `cost:llm:${dateKeyInBeijing(new Date())}`,
    'memory:index',
    'emotion:state',
  ];
  for (const k of kvKeys) await c.env.KV.delete(k).catch(() => {});
  return c.json({ ok: true, d1, r2_deleted: r2, kv_cleared: kvKeys.length });
});
app.post('/api/admin/run-daily', requireAuth, async (c) => {
  const result = await runDailyArchive(c.env, new Date());
  return c.json({ ok: true, ...result });
});
/**
 * 重建日归档（重写 R2 chat_logs；D1 消息不动）。
 * body: { dates?: string[]; distill?: boolean }，不传 dates 则按 D1 里出现的所有 date_key 逐天重建。
 * distill 默认 false：只重建日志，不重复提炼记忆；显式传 true 才会重新提炼（并先备份 memory.md）。
 */
app.post('/api/admin/rearchive-logs', requireAuth, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { dates?: string[]; distill?: boolean };
  const reDistill = body.distill === true;
  if (reDistill) {
    const backup = `memory/backups/${new Date().toISOString().replace(/[:.]/g, '-')}.md`;
    await putObject(c.env, backup, await getMemory(c.env));
  }
  let dates = Array.isArray(body.dates) ? body.dates : [];
  if (dates.length === 0) {
    const rows = await c.env.DB.prepare(
      'SELECT DISTINCT date_key FROM messages ORDER BY date_key ASC',
    ).all<{ date_key: string }>();
    dates = (rows.results ?? []).map((r) => r.date_key).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
  }
  const done: Array<{ date: string; messages: number; distilled: boolean; memory_bytes: number }> = [];
  for (const date of dates) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    // 允许重跑：清掉该日的归档锁。不要先删旧日志——
    // D1 已被清理时，archiveOneDay 还要靠旧日志恢复原始对话。
    await c.env.DB.prepare(
      "DELETE FROM cron_runs WHERE job_type = 'daily_archive' AND target = ?",
    )
      .bind(date)
      .run();
    const r = await archiveOneDay(c.env, date, new Date(), { memory: reDistill });
    done.push({
      date,
      messages: r.messages,
      distilled: r.distilled,
      memory_bytes: r.memory_bytes_after,
    });
  }
  return c.json({ ok: true, re_distill: reDistill, dates: done });
});
app.post('/api/admin/run-monthly', requireAuth, async (c) => {
  const result = await runMonthlyMerge(c.env, new Date());
  return c.json({ ok: true, ...result });
});
/** 调试：直接验证情绪 AI 复核链路（输入文本 → 关键词 → 是否需要 AI → AI 结果）。
 * 仅用于排查 Workers AI 链路，保留但需登录。
 */
app.post('/api/admin/test-mood', requireAuth, async (c) => {
  const body = await c.req.json().catch(() => null);
  const text = body && typeof body.text === 'string' ? body.text : '';
  if (!text) return c.json({ error: 'missing text' }, 400);

  const keyword = analyzeMood(text);
  const need = needsAiVerification(text, keyword);

  // 直接试调 Workers AI，把原始响应/错误一并返回，便于定位
  let rawResponse: unknown = null;
  let aiError: string | null = null;
  if (need) {
    try {
      rawResponse = await c.env.AI.run(c.env.DISTILL_MODEL, {
        messages: [
          { role: 'system', content: '只输出一个词：low/tired/busy/happy/neutral' },
          { role: 'user', content: text },
        ],
        max_tokens: 10,
        temperature: 0.1,
      } as never);
    } catch (e) {
      aiError = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    }
  }

  const aiLabel = need ? await verifyMoodWithAI(c.env, text, keyword) : null;
  const merged = aiLabel ? mergeMood(keyword, aiLabel) : keyword;
  return c.json({
    ok: true,
    text,
    keyword,
    needs_ai: need,
    ai_label: aiLabel,
    ai_raw: rawResponse,
    ai_error: aiError,
    model: c.env.DISTILL_MODEL,
    final: merged,
  });
});

/** 调试：查看当前情感系统全貌（5 轴关系 + 8 维情绪 + 未化解芥蒂）。
 * 数值只在这里展示，不进提示词。
 */
app.get('/api/admin/relation', requireAuth, async (c) => {
  const now = Date.now();
  const memory = await getMemory(c.env);
  const baseVals = parseRelationValues(memory);
  const state = await loadEmotionState(c.env, now);
  const facets = effectiveFacets(facetsOf(baseVals), state.facetDelta);
  const detail = describeEmotionState({ facets, vector: state.vector, events: state.events, now });
  return c.json({
    ok: true,
    memory_values: baseVals,
    facets,
    archetype: currentArchetype(facets, state.vector).label,
    emotion: detail,
    pending_facet_delta: state.facetDelta,
    open_grievances: listOpenGrievances(state, now).map((e) => ({
      type: e.type,
      intensity: e.intensity,
      evidence: e.evidence,
      at: e.at,
    })),
    snapshot: buildEmotionSnapshot({ facets, vector: state.vector, events: state.events, now }),
    affect_engine: c.env.AFFECT_ENGINE ?? 'legacy',
    policy: explainAttitude({
      facets,
      vector: state.vector,
      events: state.events,
      now,
    }),
    timeline: await listAffectTimeline(c.env, 30),
  });
});

/** Phase 3：解释当前态度（结构化原因 + 未化解事件）。 */
app.get('/api/admin/affect/explain', requireAuth, async (c) => {
  const now = Date.now();
  const memory = await getMemory(c.env);
  const state = await loadEmotionState(c.env, now);
  const facets = effectiveFacets(facetsOf(parseRelationValues(memory)), state.facetDelta);
  const policy = explainAttitude({ facets, vector: state.vector, events: state.events, now });
  const snapshotId = await recordAttitudeSnapshot(c.env, policy, facets, state.vector, now);
  return c.json({
    ok: true,
    policy,
    snapshot_id: snapshotId,
    timeline: await listAffectTimeline(c.env, 50),
  });
});

/** Phase 3：重置情绪；关系重置会先备份 memory.md。必须 confirm。 */
app.post('/api/admin/affect/reset', requireAuth, async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    confirm?: unknown;
    scope?: unknown;
  } | null;
  if (body?.confirm !== true) return c.json({ error: '需要 body.confirm=true' }, 400);
  const scope = body.scope === 'relationship' ? 'relationship' : body.scope === 'all' ? 'all' : 'emotion';
  let backupKey: string | null = null;
  if (scope === 'relationship' || scope === 'all') {
    const memory = await getMemory(c.env);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    backupKey = `memory/backup/reset-${stamp}.md`;
    await putObject(c.env, backupKey, memory, { contentType: 'text/markdown' });
    await putMemory(
      c.env,
      setRelationValues(memory, {
        affinity: 500,
        intimacy: 300,
        mood: 500,
        trust: 600,
        respect: 650,
        attraction: 300,
      }),
    );
  }
  if (scope === 'emotion' || scope === 'all') await resetEmotionState(c.env);
  return c.json({ ok: true, scope, backupKey });
});

/** 调试：喂一段对话，看会生成什么情绪快照（不写入 KV，不影响线上状态）。 */
app.post('/api/admin/emotion/simulate', requireAuth, async (c) => {
  const body = await c.req.json().catch(() => null);
  const texts: string[] = Array.isArray(body?.texts)
    ? body.texts.filter((t: unknown): t is string => typeof t === 'string')
    : typeof body?.text === 'string'
      ? [body.text]
      : [];
  if (texts.length === 0) return c.json({ error: 'missing texts' }, 400);

  const now = Date.now();
  const memory = await getMemory(c.env);
  const facets = facetsOf(parseRelationValues(memory));
  const result = simulateEmotion(texts, facets, now);
  return c.json({ ok: true, ...result });
});

/** Phase 3：喂一条消息，真实写入情绪/关系账本（管理端调试用）。 */
app.post('/api/admin/affect/ingest', requireAuth, async (c) => {
  const body = (await c.req.json().catch(() => null)) as { text?: unknown } | null;
  const text = typeof body?.text === 'string' ? body.text.trim().slice(0, 2000) : '';
  if (!text) return c.json({ error: 'missing text' }, 400);
  const now = Date.now();
  const memory = await getMemory(c.env);
  const result = await processEmotionTurn({
    env: c.env,
    now,
    base: facetsOf(parseRelationValues(memory)),
    userText: text,
  });
  const policy = explainAttitude({
    facets: result.facets,
    vector: result.state.vector,
    events: result.state.events,
    now,
  });
  return c.json({
    ok: true,
    facets: result.facets,
    snapshot: result.snapshot,
    policy,
    timeline: await listAffectTimeline(c.env, 20),
  });
});

/** 手动触发上下文刷新（天气 + 心情环境漂移 + 关系快照），用于调试环境心情。 */
app.post('/api/admin/run-context', requireAuth, async (c) => {
  const now = new Date();
  const dateKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(now);
  const memoryBefore = await getMemory(c.env);
  const relationBefore = parseRelationValues(memoryBefore);

  await runContextRefresh(c.env, now);

  const memoryAfter = await getMemory(c.env);
  const relationAfter = parseRelationValues(memoryAfter);
  const ctxFile = await getOrCreateDayContext(c.env, dateKey);

  return c.json({
    ok: true,
    date_key: dateKey,
    relation: { before: relationBefore, after: relationAfter },
    weather: ctxFile.weather ?? null,
    context_relation: (ctxFile as unknown as { relation?: unknown }).relation ?? null,
  });
});

/** KV 审计：列出当前 KV key 分布 + runtime_state 迁移情况。读写次数以 Cloudflare Dashboard 为准。 */
app.get('/api/admin/kv-audit', requireAuth, async (c) => {
  let keys: string[] = [];
  let listTruncated = false;
  try {
    const listed = await c.env.KV.list({ limit: 1000 });
    keys = listed.keys.map((k) => k.name);
    listTruncated = !listed.list_complete;
  } catch {
    listTruncated = true;
  }
  const prefixes = new Map<string, number>();
  for (const key of keys) {
    const prefix = key.includes(':') ? key.slice(0, key.indexOf(':') + 1) : key;
    prefixes.set(prefix, (prefixes.get(prefix) ?? 0) + 1);
  }
  let runtimeRows = 0;
  let runtimeExpired = 0;
  try {
    const row = await c.env.DB.prepare(
      'SELECT COUNT(*) AS c, SUM(CASE WHEN expires_at IS NOT NULL AND expires_at <= ? THEN 1 ELSE 0 END) AS e FROM runtime_state',
    )
      .bind(Date.now())
      .first<{ c: number; e: number | null }>();
    runtimeRows = row?.c ?? 0;
    runtimeExpired = row?.e ?? 0;
  } catch {
    /* 表未迁移 */
  }
  return c.json({
    ok: true,
    auth_mode: c.env.AUTH_MODE ?? 'signed',
    kv: {
      total_keys: keys.length,
      list_truncated: listTruncated,
      prefixes: [...prefixes.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([prefix, count]) => ({ prefix, count })),
    },
    runtime_state: { rows: runtimeRows, expired: runtimeExpired },
    note: 'KV 读/写/删次数请查看 Cloudflare Dashboard → Workers & Pages → KV → Metrics；本接口只做 key 分布审计。',
  });
});

/** 请求级 trace：默认最近 24 小时，按路径聚合（p50/p95/错误）+ 最近 N 条明细。 */
app.get('/api/admin/requests', requireAuth, async (c) => {
  const hours = Math.min(168, Math.max(1, Number(c.req.query('hours') ?? 24) || 24));
  const limit = Math.min(200, Math.max(1, Number(c.req.query('limit') ?? 30) || 30));
  const now = Date.now();
  const [stats, recent] = await Promise.all([
    readPathStats(c.env, { windowMs: hours * 3600_000, now }),
    readRecentRequests(c.env, limit),
  ]);
  return c.json({ ok: true, hours, limit, stats, recent });
});

}
