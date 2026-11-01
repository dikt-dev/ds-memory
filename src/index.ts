/**
 * DeepSeek 长期记忆代理 · Worker 入口。
 * 阶段 1：口令鉴权 + SSE 聊天链路 + 历史恢复；阶段 2/3：定时任务占位。
 */
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Env } from './types';
import { buildDayContext, hasHolidayTable } from './holidays';
import { addDays, dateKeyInBeijing, isoInBeijing } from './date';
import {
  AUTH_TOKEN_TTL_SECONDS,
  authMode,
  authSecret,
  isAuthTokenRevoked,
  revokeAllAuth,
  randomHex,
  signAuthToken,
  verifyAuthToken,
  verifyPassword,
} from './auth';
import { registerAdminRoutes } from './admin-routes';
import { registerProactiveRoutes } from './routes-proactive';
import { registerAppRoutes, sanitizeStoredMessages } from './routes-app';
import { registerMediaRoutes } from './routes-media';
import { checkAppOrQueueAuth, checkQueueAuth } from './queue-auth';
import { requireApp, requireAuth } from './middleware';
import { streamChat } from './chat';
import { messagesPage, usageByDay, messagesByDate, assistantReplyTo, type MessageRow } from './db';
import { getMemory, MEMORY_KV_KEY, putMemory } from './memory';
import { applyMemoryCorrection } from './memory-correction';
import { archivedMessagesBefore } from './archive';
import { messagesSince, webMessagesSince, latestWebMessageId } from './db';
import { byteLength, memoryDensity, mergeMemoryEntry } from './memory-maintenance';
import { getCityConfig, setCity } from './settings';
import { fetchWeather } from './weather';
import { buildAudioKey, buildImageKey, parseByteRange, saveImage } from './media';
import SparkMD5 from 'spark-md5';
import {
  deleteObject,
  getObject,
  getStorageMode,
  headObject,
  listKeys,
  probeSecondaryR2,
  putObject,
  secondaryEnabled,
} from './storage';
import { runDailyArchive, runContextRefresh, runMonthlyMerge, archiveOneDay } from './jobs';
import {
  extractPromptMemory,
  MEMORY_INLINE_MAX_BYTES,
  SEMANTIC_DUP_COSINE,
  reindexMemory,
} from './memory-index';
import { listSnapshots, restoreSnapshot } from './memory-snapshot';
import {
  backfillMemoryProvenance,
  embedMemoryChunks,
  loadMemoryChunks,
  memoryContextStats,
  memoryJobStats,
  replaceMemoryContext,
  syncArchiveContext,
  syncRollupSummaries,
  type MemoryContextStats,
  type MemoryJobStats,
} from './memory-context-store';
import { enqueueMemoryJob, runMemoryJobs } from './memory-jobs';
import { expandLinkedChunks, expansionBudget, linkAllFacts, linksForMemory } from './memory-links';
import { rankMemoryChunks } from './memory-domain';
import { resolveRecall } from './memory-engine';
import { applyMemoryProjection, buildMemoryProjection } from './memory-projection';
import { generateRollup, previousPeriods } from './memory-rollups';
import { getOrCreateDayContext } from './context';
import { parseRelationValues, reportSectionBudgets, setRelationValues } from './memory-maintenance';
import { analyzeMood } from './mood';
import { mergeMood, needsAiVerification, verifyMoodWithAI } from './mood-ai';
import {
  diagnoseProactive,
  runProactiveNow,
  runWebProactiveRandom,
  runWebProactiveSlot,
} from './webproactive';
import { fallbackPlanTimes, readPlan } from './proactive-plan';
import { openaiApp, stripAttachmentWrapper, checkBearer } from './openai';
import { getLlmCost } from './llm-cost';
import { getRecentMemo } from './recent-memory';
import { CORE_TARGET_BYTES, getArchiveLines } from './memory-archive';
import { maybeSummarizeToday } from './summary';
import { maybeRefreshRecentMemo } from './recent-memory';import { normalizeChannel } from './prompt';
import {
  currentArchetype,
  effectiveFacets,
  facetsOf,
  listOpenGrievances,
  loadEmotionState,
  processEmotionTurn,
  resetEmotionState,
  simulateEmotion,
} from './emotion-context';
import { explainAttitude } from './attitude-policy';
import { listAffectTimeline, recordAttitudeSnapshot } from './affect-store';
import { readRecallSamples, summarizeSamples } from './recall-samples';
import { readUsageStats, summarizeUsage } from './usage-stats';
import { backfillEvents, readEventStats } from './memory-events';
import { loadTtsConfig, saveTtsConfig, speakWithCache } from './tts-config';
import { getStatusSnapshot } from './status';
import {
  insertKeepsake,
  loadKeepsakes,
  refreshKeepsakesBlock,
  setKeepsakePinned,
  setKeepsakeStatus,
} from './keepsakes';
import { readEngineMetrics } from './engine-metrics';
import {
  ackTtsJob,
  claimTtsJob,
  createTtsJob,
  fallbackTtsJob,
  getTtsJob,
  nackTtsJob,
} from './tts';
import { applyEventsToVector, extractEmotionEvents, reconcileWithApology, type EmotionEvent } from './emotion-events';
import { buildEmotionSnapshot, describeEmotionState } from './emotion-snapshot';
import { decayEmotion, emptyEmotionVector, type EmotionVector } from './emotion-vector';
import { elapsedMs, logTrace, REQUEST_ID_HEADER, shouldLogHttp, startTrace } from './trace';
import { runLifeMorning } from './life/jobs';
import { flushHeldMessages } from './life/flush';
import { maybeSendPostcard } from './life/postcard';
import { pruneRequestLog, readPathStats, readRecentRequests, recordRequest } from './request-log';
import { deleteRuntimeState, getRuntimeState, putRuntimeState } from './runtime-store';
import { getHeartbeat } from './profile-cache';
import { logError, logWarn } from './error-log';

type AppEnv = { Bindings: Env; Variables: { requestId: string } };

const app = new Hono<AppEnv>();

/** 只给测试用：路由清单快照（拆分路由文件时防止漏挂）。 */
export const routesForTest = app;

// Phase 0 可观测性：每个请求带 request-id；只记录关键路径/错误，避免轮询刷屏。
app.use('*', async (c, next) => {
  const trace = startTrace(c.req.header(REQUEST_ID_HEADER));
  c.set('requestId', trace.requestId);
  c.header(REQUEST_ID_HEADER, trace.requestId);
  await next();
  const status = c.res.status;
  if (shouldLogHttp(c.req.path, status)) {
    const ms = elapsedMs(trace);
    logTrace('http', {
      requestId: trace.requestId,
      method: c.req.method,
      path: c.req.path,
      status,
      ms,
    });
    // 这条网络连不上 wrangler tail，日志只有落 D1 才看得见（见 src/request-log.ts）
    const write = recordRequest(c.env, {
      requestId: trace.requestId,
      kind: 'http',
      method: c.req.method,
      path: c.req.path,
      status,
      ms,
      channel: c.req.header('x-client-channel') || undefined,
      ok: status < 400,
    });
    try {
      c.executionCtx.waitUntil(write);
    } catch {
      await write;
    }
  }
});

const AUTH_KV_PREFIX = 'auth:';
const AUTH_TTL_SECONDS = AUTH_TOKEN_TTL_SECONDS;

/** 资源连通性检查（阶段 0 验收项）。 */
app.get('/api/health', async (c) => {
  const checks: Record<string, string> = {};
  try {
    await c.env.DB.prepare('SELECT 1 AS ok').first();
    checks.d1 = 'ok';
  } catch {
    checks.d1 = 'unavailable';
  }
  try {
    await c.env.KV.get('health:check');
    checks.kv = 'ok';
  } catch {
    checks.kv = 'unavailable';
  }
  try {
    await c.env.R2.head('memory.md');
    checks.r2 = 'ok';
  } catch {
    checks.r2 = 'unavailable';
  }
  checks.ai = 'bound';
  checks.deepseek_key = c.env.DEEPSEEK_API_KEY ? 'configured' : 'missing';
  checks.password = c.env.ACCESS_PASSWORD_HASH ? 'configured' : 'missing';
  checks.astrobot_key = c.env.ASTROBOT_API_KEY ? 'configured' : 'missing';
  // 节假日表哨兵：未收录当年表时会退化为"仅周末"，春节/国庆会判错
  checks.holiday_table = hasHolidayTable(dateKeyInBeijing()) ? 'ok' : 'missing-for-current-year';
  checks.storage_mode = await getStorageMode(c.env);
  checks.secondary_r2 = secondaryEnabled(c.env) ? 'configured' : 'missing';
  return c.json({ status: 'ok', time: isoInBeijing(), checks });
});

/** 小号 R2 兜底诊断：只做一次 put/get/delete，不切换存储模式。 */
app.get('/api/admin/storage-check', requireAuth, async (c) => {
  return c.json({
    mode: await getStorageMode(c.env),
    secondary_enabled: secondaryEnabled(c.env),
    probe: await probeSecondaryR2(c.env),
  });
});

/** 当天上下文预览（含天气）。 */
app.get('/api/day', async (c) => {
  const dateKey = dateKeyInBeijing();
  const cacheKey = `day:cache:${dateKey}`;
  // 天气每次都要打外网，而首屏就等它：10 分钟内复用同一份
  const cached = await c.env.KV.get(cacheKey).catch(() => null);
  if (cached) {
    return c.json(JSON.parse(cached) as Record<string, unknown>, 200, {
      'cache-control': 'private, max-age=60',
    });
  }
  const ctx = buildDayContext(dateKey);
  const cfg = await getCityConfig(c.env);
  const weather = await fetchWeather(c.env);
  const payload = { ...ctx, city: cfg.city, weather };
  await c.env.KV.put(cacheKey, JSON.stringify(payload), { expirationTtl: 600 }).catch(() => {});
  return c.json(payload, 200, {
    'cache-control': 'private, max-age=60',
  });
});

/** DeepSeek 账户余额（代理官方接口，密钥不出服务端）。 */
app.get('/api/balance', requireAuth, async (c) => {
  const apiKey = c.env.DEEPSEEK_API_KEY;
  if (!apiKey) return c.json({ error: 'DEEPSEEK_API_KEY 未配置' }, 500);
  const cachedBalance = await c.env.KV.get('balance:snapshot').catch(() => null);
  if (cachedBalance) {
    return c.json(JSON.parse(cachedBalance) as Record<string, unknown>, 200, {
      'cache-control': 'private, max-age=60',
    });
  }
  try {
    const res = await fetch('https://api.deepseek.com/user/balance', {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) return c.json({ error: `余额查询失败（${res.status}）` }, 502);
    const data = (await res.json()) as {
      is_available?: boolean;
      balance_infos?: Array<{
        currency?: string;
        total_balance?: string;
        granted_balance?: string;
        topped_up_balance?: string;
      }>;
    };
    const info = data.balance_infos?.[0];
    const snapshot = {
      available: data.is_available ?? false,
      currency: info?.currency ?? 'CNY',
      total: Number(info?.total_balance ?? 0),
      granted: Number(info?.granted_balance ?? 0),
      topped_up: Number(info?.topped_up_balance ?? 0),
    };
    await c.env.KV.put('balance:snapshot', JSON.stringify(snapshot), { expirationTtl: 300 }).catch(() => {});
    return c.json(snapshot, 200, {
      'cache-control': 'private, max-age=60',
    });
  } catch (e) {
    logError('[balance] fetch failed:', e);
    return c.json({ error: '余额查询失败' }, 502);
  }
});

/** 城市设置（阶段 4 T4.6）：读取当前配置。 */
app.get('/api/settings', async (c) => {
  return c.json(await getCityConfig(c.env));
});

/** 修改城市：支持城市名（服务端地理编码）或浏览器定位坐标（直接采用）。 */
app.post('/api/admin/settings', requireAuth, async (c) => {
  const body = await c.req.json().catch(() => null);
  const city = body && typeof body.city === 'string' ? body.city.trim() : '';
  const latitude = body && typeof body.latitude === 'number' ? body.latitude : undefined;
  const longitude = body && typeof body.longitude === 'number' ? body.longitude : undefined;
  const hasCoords = latitude !== undefined && longitude !== undefined;
  if ((!city && !hasCoords) || city.length > 30) return c.json({ error: '城市名或坐标无效' }, 400);
  try {
    const config = await setCity(
      c.env,
      city || '当前位置',
      hasCoords ? { latitude: latitude!, longitude: longitude! } : undefined,
    );
    return c.json({ ok: true, ...config });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : '设置失败' }, 400);
  }
});

/** 登录失败限流：同一 IP 10 分钟内最多 5 次。 */
const LOGIN_MAX_FAILS = 5;
const LOGIN_WINDOW_SECONDS = 10 * 60;

/** 口令登录：校验哈希 → 签发随机 token 存 KV（7 天）→ Set-Cookie。 */
app.post('/api/login', async (c) => {
  const body = await c.req.json().catch(() => null);
  const password = body && typeof body.password === 'string' ? body.password : '';
  const stored = c.env.ACCESS_PASSWORD_HASH;
  if (!stored) return c.json({ error: '服务端未配置访问口令' }, 500);

  const ip = c.req.header('cf-connecting-ip') ?? 'local';
  const failKey = `login:fail:${ip}`;
  const fails = Number(await c.env.KV.get(failKey).catch(() => null)) || 0;
  if (fails >= LOGIN_MAX_FAILS) {
    return c.json({ error: '尝试次数过多，请 10 分钟后再试' }, 429);
  }

  if (!(await verifyPassword(password, stored))) {
    await c.env.KV.put(failKey, String(fails + 1), { expirationTtl: LOGIN_WINDOW_SECONDS }).catch(() => {});
    return c.json({ error: '口令错误' }, 401);
  }
  await c.env.KV.delete(failKey).catch(() => {});

  const secret = authSecret(c.env);
  let token: string;
  if (authMode(c.env) === 'signed' && secret) {
    token = (await signAuthToken(secret)).token;
  } else {
    token = randomHex(32);
    await c.env.KV.put(`${AUTH_KV_PREFIX}${token}`, '1', { expirationTtl: AUTH_TTL_SECONDS });
  }
  setCookie(c, 'ds_token', token, {
    httpOnly: true,
    sameSite: 'Strict',
    secure: true,
    path: '/',
    maxAge: AUTH_TTL_SECONDS,
  });
  return c.json({ ok: true });
});

app.post('/api/logout', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { all?: unknown } | null;
  if (body?.all === true) {
    // 全部登出：写全局吊销；signed token 在吊销时间之前的都失效。
    await revokeAllAuth(c.env);
  } else {
    const token = getCookie(c, 'ds_token');
    if (token) await c.env.KV.delete(`${AUTH_KV_PREFIX}${token}`).catch(() => {});
  }
  deleteCookie(c, 'ds_token', { path: '/' });
  return c.json({ ok: true });
});

/** 聊天：组装上下文 → DeepSeek 流式 → SSE 透传（可选附图片；支持渠道标识）。 */
app.post('/api/chat', requireAuth, async (c) => {
  const body = await c.req.json().catch(() => null);
  const content = body && typeof body.content === 'string' ? body.content.trim() : '';
  const rawImage =
    body && typeof body.image === 'string' && body.image.startsWith('data:image/') ? body.image : undefined;
  if (!content && !rawImage) return c.json({ error: '消息不能为空' }, 400);
  if (content.length > 20000) return c.json({ error: '消息过长（最多 20000 字符）' }, 400);
  // 渠道：未来手机/电脑/桌宠客户端可通过 body.channel 或 X-Client-Channel 头声明
  const channel = normalizeChannel(
    (body && typeof body.channel === 'string' ? body.channel : undefined) ?? c.req.header('x-client-channel'),
    'web',
  );
  const now = new Date();
  const dateKey = dateKeyInBeijing(now);
  // 异步滚动摘要：达到阈值自动提炼，不阻塞本次聊天
  c.executionCtx.waitUntil(maybeSummarizeToday(c.env, dateKey));
  // 异步刷新中期记忆（最近 24 小时纪要）
  c.executionCtx.waitUntil(maybeRefreshRecentMemo(c.env, now));

  let image: { key: string } | undefined;
  if (rawImage) {
    const saved = await saveImage(c.env, rawImage, dateKey, now);
    if (!saved) return c.json({ error: '图片格式不支持或超过 8MB 限制' }, 400);
    image = { key: saved.key };
  }
  return streamChat(c.env, content, now, image, channel, c.get('requestId'));
});

app.get('/api/history/since', requireAuth, async (c) => {
  const rawAfter = Number(c.req.query('after_id') ?? '');
  const afterId = Number.isFinite(rawAfter) && rawAfter >= 0 ? Math.floor(rawAfter) : 0;
  const rawLimit = Number(c.req.query('limit') ?? '50');
  const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 50, 1), 100);
  const { messages, hasMore } = await messagesSince(c.env, afterId, limit);
  return c.json({
    messages: sanitizeStoredMessages(messages),
    has_more: hasMore,
    latest_id: messages.length > 0 ? messages[messages.length - 1].id : afterId,
  });
});

/** 网页 → QQ 同步：只返回 channel='web' 的普通聊天，Bearer (ASTROBOT_API_KEY) 鉴权。 */
app.get('/api/qq/outbox', async (c) => {
  if (!(await checkBearer(c))) return c.json({ error: '无效的 API Key' }, 401);
  if (c.req.query('baseline') === '1') {
    return c.json({ messages: [], latest_id: await latestWebMessageId(c.env), has_more: false });
  }
  const rawAfter = Number(c.req.query('after_id') ?? '');
  const afterId = Number.isFinite(rawAfter) && rawAfter >= 0 ? Math.floor(rawAfter) : 0;
  const rawLimit = Number(c.req.query('limit') ?? '20');
  const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 20, 1), 50);
  const { messages, hasMore } = await webMessagesSince(c.env, afterId, limit);
  const payload = messages.map((m) => ({
    id: m.id,
    role: m.role,
    content: m.content,
    created_at: m.created_at,
  }));
  return c.json({
    messages: sanitizeStoredMessages(payload),
    has_more: hasMore,
    latest_id: messages.length > 0 ? messages[messages.length - 1].id : afterId,
  });
});

/** 聊天历史（分页，全量回放）：?limit=50&before_id=<上一页最小编号>，升序返回。 */
app.get('/api/history', requireAuth, async (c) => {
  const raw = Number(c.req.query('limit') ?? '50');
  const limit = Math.min(Math.max(Number.isFinite(raw) ? raw : 50, 1), 100);
  const rawBefore = Number(c.req.query('before_id') ?? '');
  const beforeId = Number.isFinite(rawBefore) && rawBefore > 0 ? Math.floor(rawBefore) : undefined;
  const { messages, hasMore } = await messagesPage(c.env, { beforeId, limit });
  return c.json({
    messages: sanitizeStoredMessages(messages),
    has_more: hasMore,
    next_before_id: messages.length > 0 ? messages[0].id : null,
  });
});

/** 计费统计：今日 + 最近 7 天（按天聚合 D1 中 messages，并补上提炼/摘要的 KV 记账）。 */
app.get('/api/usage', requireAuth, async (c) => {
  // 费用统计 60 秒内不必重算
  const today = dateKeyInBeijing();
  const seven = addDays(today, -6);
  const days = await usageByDay(c.env, seven);
  const withLlm = await Promise.all(
    days.map(async (d) => ({ ...d, cost: d.cost + (await getLlmCost(c.env, d.date)) })),
  );
  return c.json({
    today: withLlm.find((d) => d.date === today)?.cost ?? 0,
    total_7d: withLlm.reduce((s, d) => s + d.cost, 0),
    days: withLlm,
  });
});

// 管理端路由见 admin-routes.ts（registerAdminRoutes）
registerAdminRoutes(app);
// 主动消息队列见 routes-proactive.ts
registerProactiveRoutes(app);
// App 客户端接口见 routes-app.ts
registerAppRoutes(app);
// 媒体/语音/外链预览见 routes-media.ts
registerMediaRoutes(app);

app.get('/api/admin/stats', requireAuth, async (c) => {
  const [countRow, oldestRow, runs, logKeys, entryRow] = await Promise.all([
    c.env.DB.prepare('SELECT COUNT(*) AS c FROM messages').first<{ c: number }>(),
    c.env.DB.prepare('SELECT MIN(date_key) AS d FROM messages').first<{ d: string | null }>(),
    c.env.DB
      .prepare('SELECT job_type, target, status, detail, run_at FROM cron_runs ORDER BY id DESC LIMIT 10')
      .all(),
    listKeys(c.env, 'chat_logs/'),
    c.env.DB
      .prepare(
        `SELECT COUNT(*) AS c,
                COALESCE(SUM(CASE WHEN vec IS NOT NULL THEN 1 ELSE 0 END), 0) AS with_vec,
                COALESCE(SUM(CASE WHEN dup_of IS NOT NULL THEN 1 ELSE 0 END), 0) AS dups,
                COALESCE(MAX(updated_at), 0) AS last_at
           FROM memory_entries`,
      )
      .first<{ c: number; with_vec: number; dups: number; last_at: number }>(),
  ]);
  const memory = await getMemory(c.env);
  const promptMemory = extractPromptMemory(memory);
  const density = memoryDensity(memory);
  // 分层记忆的可观测性：核心层占用、超预算分区、中期纪要条数、档案条数
  const [memo, archiveLines] = await Promise.all([getRecentMemo(c.env), getArchiveLines(c.env)]);
  return c.json({
    messages: countRow?.c ?? 0,
    oldest_date: oldestRow?.d ?? null,
    memory_bytes: byteLength(memory),
    memory_prompt_bytes: byteLength(promptMemory.text),
    memory_prompt_mode: promptMemory.mode,
    memory_inline_max_bytes: MEMORY_INLINE_MAX_BYTES,
    memory_density: density,
    memory_entries: entryRow?.c ?? 0,
    memory_entries_with_vec: entryRow?.with_vec ?? 0,
    memory_duplicates: entryRow?.dups ?? 0,
    last_memory_index_at: entryRow?.last_at ?? 0,
    semantic_dup_cosine: SEMANTIC_DUP_COSINE,
    // 兼容旧字段；现在只是统计参考，不再作为强制裁剪阈值
    core_target_bytes: CORE_TARGET_BYTES,
    over_budget_sections: reportSectionBudgets(memory)
      .filter((b) => b.over)
      .map((b) => ({ header: b.header, bytes: b.bytes, budget: b.budget })),
    recent_memo_items: memo ? memo.items.filter((i) => !i.superseded).length : 0,
    archive_lines: archiveLines.length,
    archive_bytes: byteLength(archiveLines.join('\n')),
    chat_log_files: logKeys.length,
    storage_mode: await getStorageMode(c.env),
    recent_jobs: runs.results ?? [],
  });
});

// —— OpenAI 兼容端点（AstrBot 等第三方接入）——
app.route('/v1', openaiApp);

/**
 * 兜底路由：静态资源透传 + HTML 角色名注入。
 *
 * ★ `/api/*` 与 `/v1/*` 不在此处理：它们各自有专属路由，未匹配时应当 404，
 *   不能把 API 的 404 变成一个 HTML 页面（会让客户端 JSON 解析踩坑）。
 *
 * 对 HTML 做角色名替换（「小忆」→ 部署者 CHARACTER_NAME），
 * 这样源码保持开源的干净设定，私有部署只改环境变量就有自己的角色名。
 * 二进制资源（图片/字体等）原样透传，不做字符串处理。
 */
app.get('*', async (c) => {
  const path = c.req.path;
  if (path.startsWith('/api/') || path.startsWith('/v1/')) {
    return c.json({ error: 'not found' }, 404);
  }

  const upstream = await c.env.ASSETS.fetch(c.req.raw);
  const ct = upstream.headers.get('content-type') ?? '';
  if (!ct.toLowerCase().includes('text/html')) return upstream;

  const name = c.env.CHARACTER_NAME?.trim() || '小忆';
  const original = await upstream.text();
  const replaced = original.replace(/小忆/g, name);
  const headers = new Headers(
    [...upstream.headers].filter(([k]) => k.toLowerCase() !== 'content-length'),
  );
  // 页面本身必须每次回源校验：静态资源没有 ETag/Last-Modified 时，浏览器会
  // 按启发式缓存一直用旧页面，前端改了也看不到（我们踩过：改了 JS 用户还在跑旧版）。
  headers.set('cache-control', 'no-store');
  return new Response(replaced, {
    headers,
    status: upstream.status,
  });
});

app.onError((err, c) => {
  logError('[worker] unhandled error:', err);
  return c.json({ error: 'internal error' }, 500);
});

/**
 * 每 8 小时刷新一次 context（天气 + 心情环境漂移 + 关系快照）。
 * 目标时刻：北京 08:00 / 16:00 / 24:00 = UTC 0 / 8 / 16 点整。
 *
 * ★ 历史 bug：这条 cron 原本只覆盖 UTC 23 / 0 / 14 / 15 点（每 5 分钟），
 *   8 点和 16 点永远不会触发，所以 `hour === 8 || hour === 16` 是死代码，
 *   实际一天只刷新一次（北京 08:00）。现在三条 cron 合起来覆盖 0/8/16。
 */
async function maybeRefreshContext(env: Env, now: Date): Promise<void> {
  if (now.getUTCMinutes() !== 0) return;
  const hour = now.getUTCHours();
  if (hour !== 0 && hour !== 8 && hour !== 16) return;
  await runContextRefresh(env, now);
}

/** 把一次 cron 的执行记进 request_log（线上没有 wrangler tail）。 */
function logCron(env: Env, ctx: ExecutionContext, cron: string, startedAt: number, ok = true): void {
  ctx.waitUntil(
    recordRequest(env, {
      requestId: `cron:${startedAt}`,
      kind: 'cron',
      path: cron,
      ms: Date.now() - startedAt,
      ok,
    }),
  );
}

export default {
  fetch: app.fetch,
  /**
   * Cloudflare Cron Triggers 入口（配置见 wrangler.toml，免费版限 3 个，故合并分发）。
   * - 每日 04:00（UTC 20:00）：归档前一天；每月 1 日同一分钟再跑月度合并
   * - 每 5 分钟（UTC 1-14 点）：纯随机主动聊天（北京 09:00-22:30）
   * - 每 5 分钟（UTC 23,0,14,15,16 点）：早晚固定主动消息 + 每 8 小时 context 刷新
   */
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    const now = new Date(controller.scheduledTime); // scheduledTime 是 epoch 毫秒数
    const cron = controller.cron;
    const startedAt = Date.now();

    if (cron === '0 20 * * *') {
      // 每天 04:00 归档前一天；每月 1 日必须等归档完成后再做上月合并，
      // 否则月度任务可能在最后一天 .log 写入前启动，触发重复补归档。
      ctx.waitUntil(
        (async () => {
          await runDailyArchive(env, now);
          const dayOfMonth = Number(
            new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', day: '2-digit' }).format(now),
          );
          if (dayOfMonth === 1) await runMonthlyMerge(env, now);
          await pruneRequestLog(env);
          // 生活系统：生成「今天」的日程。P0 阶段只写库，聊天行为不变。
          await runLifeMorning(env, now);
        })(),
      );
      logCron(env, ctx, cron, startedAt);
      return;
    }

    if (cron === '* 1-14 * * *') {
      // QQ 通道掉线检查：与主动消息是否暂停无关，每次 tick 都查
      // 白天随机主动消息：打分决策 + 落库 + 推送 QQ（直连或队列）
      ctx.waitUntil(runWebProactiveRandom(env, now));
      // 闸门补发：到点的压着消息在这里回（§8.3 cron 兜底）
      ctx.waitUntil(flushHeldMessages(env, now));
      // 旅行期间：白天每小时掷一次，掷中就发一条见闻
      ctx.waitUntil(maybeSendPostcard(env, now));
      // 这条 cron 实际覆盖 UTC 8 点 → 北京 16:00 的 context 刷新
      ctx.waitUntil(maybeRefreshContext(env, now));
      logCron(env, ctx, cron, startedAt);
      return;
    }

    if (cron === '* 23,0,14,15,16 * * *') {
      // QQ 通道掉线检查（同上）
      // 早晚固定主动消息：打分决策 + 落库 + 推送 QQ（直连或队列）
      ctx.waitUntil(runWebProactiveSlot(env, now));
      ctx.waitUntil(flushHeldMessages(env, now));
      // 这条 cron 覆盖 UTC 0 / 16 点 → 北京 08:00 / 24:00 的 context 刷新
      ctx.waitUntil(maybeRefreshContext(env, now));
      logCron(env, ctx, cron, startedAt);
      return;
    }

    logWarn('[cron] unknown cron expression:', cron);
    logCron(env, ctx, cron, startedAt, false);
  },
} satisfies ExportedHandler<Env>;
