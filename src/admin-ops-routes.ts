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
import { appendMemoryLine, removeMemoryLine } from './memory-append';
import { generateDiaryImage, lastImageError, IMAGE_MODELS } from './life/diary-image';
import { completeDeepSeek } from './deepseek';
import { SUMMARY_SYSTEM } from './life/diary-summary-gen';
import { askDiary, diaryList, diaryOne } from './life/diary-api';
import { pendingDiaryAsks } from './life/diary-job';
import { collapseOngoingItems } from './memory-ongoing-job';
import { ensureLifeDay, lifeNow } from './life/jobs';
import { maybeNightWake } from './life/night';
import { lifePromptLine } from './life/now-text';
import { generateDiary } from './life/diary-job';
import { CITIES, refreshLifeEnv, fetchWeather } from './life/weather';
import { gateDecision, lifeEnabled } from './life/gate';
import { writeTrip } from './life/travel';
import { generatePhoto } from './life/photo';
import { sendPostcard } from './life/postcard';
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
import { dateKeyInBeijing , addDays} from './date';
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
import { readAmbient } from './emotion-ambient';
import { ensureDayTopics } from './topics';
import { incrementalDistill } from './incremental-distill';
import { backfillNextDay } from './memory-backfill';
import { runProbeEval, scoreProbeAnswers } from './probe-eval';
import { getRuntimeState } from './runtime-store';
import { refreshChunksCache } from './memory-context-store';
import { readContextSnapshot, rebuildContextSnapshot, ensureContextSnapshot } from './context-snapshot';
import { explainAttitude } from './attitude-policy';
import { listAffectTimeline, recordAttitudeSnapshot } from './affect-store';
import { readPathStats, readRecentRequests } from './request-log';
import { logError, logWarn } from './error-log';
import { loadPersonaDoc } from './persona-doc';
import { loadLifeBlocks } from './chat-blocks';
import { buildSystemPromptSplit, silentEndRule } from './prompt';
import { loadSessionHistory } from './recent-context';
import { resolvePersona } from './persona';
import { getOrCreateDayContext } from './context';

/**
 * 运维/维护类后台接口：清库、重跑任务、KV 审计、请求统计……
 *
 * 从 admin-routes.ts 里整段搬出来——那一个文件 1436 行、89 个路由，
 * 找一条路由要先滚屏。这些接口和"记忆"没有概念关系，放在一起只是历史堆积。
 * 搬动是纯机械的：路由清单快照（routes.snapshot.json）保证一条不多一条不少。
 */
export function registerAdminOpsRoutes(app: Hono<AppEnv>): void {

  /**
   * 看一眼这一轮真正会发出去的东西：人设、名录、记忆、时间。
   * 只在后台用；text 模拟用户那句话。
   */
  app.get('/api/admin/prompt/peek', requireAuth, async (c) => {
    const text = c.req.query('text') || '在吗';
    const now = new Date();
    const [personaDoc, lifeBlocks, memory, ctx] = await Promise.all([
      loadPersonaDoc(c.env),
      // ?recent= 逗号分隔，调试「上一句提过谁」这种跨轮唤醒
      loadLifeBlocks(
        c.env,
        now,
        text,
        (c.req.query('recent') || '')
          .split('|')
          .map((t) => t.trim())
          .filter(Boolean)
          .map((t, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: t })),
      ),
      getMemory(c.env).catch(() => null),
      getOrCreateDayContext(c.env, beijingDateKey()).catch(() => null),
    ]);
    // 天气：跟她说话时「你这边」的那份，和聊天链路一致
    const homeCity = (await c.env.KV.get('life:home-city').catch(() => null)) ?? c.env.CITY ?? '杭州';
    const w = await fetchWeather(homeCity).catch(() => null);
    const descOf = (v?: string) =>
      v === 'rain' ? '在下雨' : v === 'snow' ? '在下雪' : v === 'sunny' ? '晴' : '阴';
    const weather = w ? { city: homeCity, desc: descOf(w.weather), temp_c: Math.round(w.tempC) } : null;
    const parts = buildSystemPromptSplit({
      now,
      ctx: ctx as never,
      memory: memory ?? null,
      channel: 'web',
      personaDoc,
      userText: text,
      persona: resolvePersona(c.env),
      weather: weather ?? undefined,
      residents: lifeBlocks.residents,
    location: lifeBlocks.location,
      // 和 chat.ts 一致：被问的日记要带上日期 + 她自己写的备忘摘要，否则这个调试页看不到真实提示词
      life:
        [lifeBlocks.life, await diaryAskPreview(c.env)].filter(Boolean).join('\n\n') || null,
    } as never);
    const enc = new TextEncoder();
    // 和 chat.ts 一模一样的拼法：稳定段 + [提要] + 历史 + 易变段 + 用户消息
    const messages: { role: string; content: string }[] = [
      { role: 'system', content: parts.stable + silentEndRule('web') },
    ];
    const hist = await loadSessionHistory(c.env, now).catch(() => ({ rows: [], brief: '', rounds: 0 }));
    if (hist.brief) messages.push({ role: 'system', content: hist.brief });
    for (const m of hist.rows) messages.push({ role: m.role, content: m.content });
    if (parts.volatile) messages.push({ role: 'system', content: parts.volatile });
    messages.push({ role: 'user', content: text });
    return c.json({
      ok: true,
      text,
      stableBytes: enc.encode(parts.stable).length,
      volatileBytes: enc.encode(parts.volatile).length,
      historyCount: hist.rows.length,
      messages,
      stable: parts.stable,
      volatile: parts.volatile,
    });
  });
  /**
   * 批量清空 KV（需 confirm=yes）。
   *
   * 擦除数据时，D1 和 R2 都有现成的 wipe-data，唯独 KV 只能一条条删——
   * 手机端每条消息都会写一个 `app:cmid:*` 去重键，几百条要删十几分钟。
   * 这里用 KV 自己的 list + delete 在服务端一次跑完，既是运维工具，也是测试清理手段。
   */
  app.post('/api/admin/kv/clear', requireAuth, async (c) => {
    if (c.req.query('confirm') !== 'yes') {
      return c.json({ error: '需要 confirm=yes' }, 400);
    }
    const prefix = c.req.query('prefix') ?? undefined;
    let cursor: string | undefined;
    let deleted = 0;
    for (let page = 0; page < 200; page++) {
      const listed = await c.env.KV.list({ prefix, cursor, limit: 1000 });
      for (const key of listed.keys) {
        await c.env.KV.delete(key.name);
        deleted += 1;
      }
      if (listed.list_complete) break;
      cursor = listed.cursor;
    }
    return c.json({ ok: true, deleted });
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
/**
 * 彻底重置（只留人设与配对）：清空所有业务表、聊天派生的 R2 对象、派生缓存 KV，
 * 并把 emotion 状态一起抹掉（emotion:state 在 runtime_state 里，整表删除即可）。
 *
 * 保留：persona.md（她是谁）、memory.md 的「人物底色 / 他的雷区 / 称呼与关系」三块、
 * KV 里的配对令牌 app:device:*、以及 pair:code。
 */
app.post('/api/admin/reset-chat', requireAuth, async (c) => {
  if (c.req.query('confirm') !== 'yes') return c.json({ error: '需要 confirm=yes' }, 400);

  // 1) D1：按 sqlite_master 真实表名删，避免漏掉后来新增的表（上次就是这么漏的）
  const listed = await c.env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('_cf_KV','sqlite_sequence')",
  ).all<{ name: string }>();
  let rows = 0;
  const cleared: string[] = [];
  for (const { name } of listed.results ?? []) {
    try {
      const r = await c.env.DB.prepare(`DELETE FROM "${name}"`).run();
      rows += r.meta.changes ?? 0;
      cleared.push(name);
    } catch {
      // 视图/虚拟表删不动就跳过，不影响其它表
    }
  }

  // 2) R2：只删聊天派生对象，persona.md / memory.md 保留
  const keep = new Set(['persona.md', 'memory.md']);
  const prefixes = [
    'chat_logs/',
    'context/',
    'memory/emotion-history/',
    'memory/backups/',
    'images/',
    'media/',
    'files/',
    'sessions/',
    'memo/',
    'summary/',
    'diary/',
    'recall/',
  ];
  const keys = await listKeys(c.env, '');
  let r2 = 0;
  for (const k of keys) {
    if (keep.has(k)) continue;
    if (!prefixes.some((p) => k.startsWith(p))) continue;
    await deleteObject(c.env, k).catch(() => {});
    r2 += 1;
  }

  // 3) KV：派生缓存全清，配对的设备令牌保留（清了手机就要重新配对）
  let kv = 0;
  const kvPrefixes = ['memo:', 'proactive:', 'profile:', 'files:', 'summary:', 'archive:', 'memory:', 'cost:'];
  for (const p of kvPrefixes) {
    let cursor: string | undefined;
    for (let page = 0; page < 50; page++) {
      const res = await c.env.KV.list({ prefix: p, cursor, limit: 500 });
      for (const k of res.keys) {
        await c.env.KV.delete(k.name);
        kv += 1;
      }
      if (res.list_complete) break;
      cursor = res.cursor;
    }
  }

  // 4) memory.md：保三块身份信息，其余清空，关系值回默认
  const text = (await getMemory(c.env).catch(() => '')) || '';
  const keepHeaders = ['## 人物底色', '## 他的雷区', '## 称呼与关系'];
  const sections = text.split(/^(?=## )/m);
  const kept = sections
    .filter((sec) => keepHeaders.some((h) => sec.startsWith(h)))
    .map((sec) => sec.trimEnd())
    .join('\n\n');
  const order = ['## 人物底色', '## 他的雷区', '## 称呼与关系', '## 关于他', '## 他的偏好', '## 进行中的事', '## 共同经历', '## 你的生活', '## 近期动态'];
  const comments: Record<string, string> = {
    '## 人物底色': '<!-- 固定设定，永不删改 -->',
    '## 他的雷区': '<!-- 他不能碰的话题与说法，永不自动删除 -->',
    '## 称呼与关系': '<!-- 称呼/暗号/约定 + 三个关系值（系统算，勿手改） -->',
    '## 关于他': '<!-- 他的身份、背景、重要的人（长期事实） -->',
    '## 他的偏好': '<!-- 他的喜好、厌恶、作息、沟通方式 -->',
    '## 进行中的事': '<!-- 他的项目/计划/待办：[进行中]/[搁置]/[已完成] -->',
    '## 共同经历': '<!-- 共同做过的事、里程碑、梗、约定 -->',
    '## 你的生活': '<!-- 你自己的事：去过哪、在追什么、自己做的决定 -->',
    '## 近期动态': '<!-- 最近几天，超7天清理 -->',
  };
  const present = new Map<string, string>();
  for (const sec of sections) {
    const h = (sec.match(/^## [^\n]+/) ?? [''])[0].trim();
    if (h) present.set(h, sec.trimEnd());
  }
  const rebuilt = order
    .map((h) => (keepHeaders.includes(h) && present.get(h) ? present.get(h)! : `${h}\n${comments[h] ?? ''}`.trimEnd()))
    .join('\n\n');
  const withValues = setRelationValues(rebuilt, {
    affinity: 500,
    intimacy: 300,
    mood: 500,
    trust: 600,
    respect: 650,
    attraction: 300,
  });
  await putMemory(c.env, withValues + '\n');

  return c.json({ ok: true, d1: { tables: cleared.length, rows }, r2_deleted: r2, kv_cleared: kv });
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

/** 记忆探针：后台跑一轮 10 题，结果写 KV + engine_metrics。 */
app.post('/api/admin/eval/probes', requireAuth, async (c) => {
  // 进程内调用也要过鉴权：临时设备令牌，10 分钟有效，跑完即删
  const token = `eval-${crypto.randomUUID()}`;
  await c.env.KV.put(`app:device:${token}`, '1', { expirationTtl: 600 });
  c.executionCtx.waitUntil(
    (async () => {
      await runProbeEval(c.env, new Date(), { token }).catch((e: unknown) => logError('[probe] run failed:', e));
      await c.env.KV.delete(`app:device:${token}`).catch(() => {});
    })(),
  );
  return c.json({ scheduled: true });
});

/** 客户端跑完探针后把原始回答交回来，由服务端统一判分入库。 */
app.post('/api/admin/eval/probes/report', requireAuth, async (c) => {
  const body = (await c.req.json().catch(() => null)) as { answers?: Array<{ id?: unknown; answer?: unknown }> } | null;
  const answers = body?.answers ?? [];
  if (!Array.isArray(answers) || answers.length === 0) {
    return c.json({ ok: false, error: '需要 answers: [{id, answer}]' }, 400);
  }
  const card = await scoreProbeAnswers(c.env, answers, new Date());
  return c.json({ ok: true, card });
});

/** 最近一次探针结果。 */
app.get('/api/admin/eval/probes', requireAuth, async (c) => {
  const raw = await c.env.KV.get('eval:probe:last').catch(() => null);
  if (!raw) return c.json({ ok: false, error: '还没有结果' }, 404);
  return c.json({ ok: true, card: JSON.parse(raw) });
});

/** 历史回填：一次补一天，反复调用直到 nothing_left。 */
app.post('/api/admin/distill/backfill', requireAuth, async (c) => {
  const r = await backfillNextDay(c.env, new Date());
  return c.json(r);
});

/** 手动跑一次增量提炼（排查/验证用）。 */
app.post('/api/admin/distill/incremental', requireAuth, async (c) => {
  const r = await incrementalDistill(c.env, new Date());
  const cursor = await getRuntimeState(c.env, 'distill:inc:cursor').catch(() => null);
  return c.json({ ...r, cursor });
});

/** 立即预热召回/上下文缓存（部署后调用）。 */
app.post('/api/admin/cache/prewarm', requireAuth, async (c) => {
  const chunks = await refreshChunksCache(c.env).catch(() => -1);
  const snapshot = await ensureContextSnapshot(c.env, new Date()).catch(() => false);
  return c.json({ ok: chunks >= 0, chunks, snapshot_rebuilt: snapshot });
});

/** 立即重建上下文快照（排查/上线后用）。 */
app.post('/api/admin/context-snapshot/rebuild', requireAuth, async (c) => {
  const ok = await rebuildContextSnapshot(c.env, new Date());
  const snap = await readContextSnapshot(c.env);
  return c.json({
    ok,
    at: snap?.at ?? null,
    has_memo: Boolean(snap?.memo),
    has_summary: Boolean(snap?.summary),
    topics: snap?.topics ?? '',
    memory_bytes: snap?.memory?.length ?? 0,
  });
});

/** 补生成最近 N 天的话题索引（排查/初始化用）。 */
app.post('/api/admin/topics/backfill', requireAuth, async (c) => {
  const days = Math.min(Math.max(Number(c.req.query('days') ?? 7), 1), 30);
  const out: Array<{ date: string; topics: string[] }> = [];
  for (let back = 0; back < days; back += 1) {
    const date = addDays(dateKeyInBeijing(new Date()), -back);
    const topics = await ensureDayTopics(c.env, date).catch(() => []);
    if (topics.length > 0) out.push({ date, topics });
  }
  return c.json({ ok: true, days, filled: out });
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
    snapshot: buildEmotionSnapshot({
      facets,
      vector: state.vector,
      events: state.events,
      now,
      ambient: await readAmbient(c.env, new Date(now)).catch(() => null),
    }),
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

/** 调试页用：复刻 chat.ts 里那段「被问的日记」提示词。 */
async function diaryAskPreview(env: AppEnv['Bindings']): Promise<string | null> {
  const asks = await pendingDiaryAsks(env).catch(() => []);
  if (asks.length === 0) return null;
  return [
    `【日记】用户在问能不能看：${asks.map((a) => a.date.slice(2)).join('、')}。`,
    ...asks.filter((a) => a.summary).map((a) => `- ${a.date.slice(2)} 那篇，你当时给自己留的备忘：${a.summary}`),
    '这些是你写的时候给自己留的备忘，不是给他看的文案——别念出来，也别逐条复述。',
    '你可以答应看全部、只给看一眼、或者拒绝。日记是存在的，别否认自己写过。说一两句就够了。',
  ].join('\n');
}