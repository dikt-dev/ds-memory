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
  isAuthTokenRevoked,
  revokeAllAuth,
  randomHex,
  signAuthToken,
  verifyAuthToken,
  verifyPassword,
} from './auth';
import { streamChat } from './chat';
import { messagesPage, usageByDay, messagesByDate, assistantReplyTo } from './db';
import { getMemory, MEMORY_KV_KEY, putMemory } from './memory';
import { messagesSince } from './db';
import { byteLength, memoryDensity } from './memory-maintenance';
import { getCityConfig, setCity } from './settings';
import { fetchWeather } from './weather';
import { saveImage } from './media';
import { deleteObject, getObject, getStorageMode, listKeys, putObject, secondaryEnabled } from './storage';
import { runDailyArchive, runContextRefresh, runMonthlyMerge, archiveOneDay } from './jobs';
import {
  extractPromptMemory,
  MEMORY_INLINE_MAX_BYTES,
  SEMANTIC_DUP_COSINE,
  reindexMemory,
} from './memory-index';
import {
  backfillMemoryProvenance,
  embedMemoryChunks,
  memoryContextStats,
  memoryJobStats,
  replaceMemoryContext,
  syncArchiveContext,
  syncRollupSummaries,
  type MemoryContextStats,
  type MemoryJobStats,
} from './memory-context-store';
import { enqueueMemoryJob, runMemoryJobs } from './memory-jobs';
import { applyMemoryProjection, buildMemoryProjection } from './memory-projection';
import { generateRollup, previousPeriods } from './memory-rollups';
import { getOrCreateDayContext } from './context';
import { parseRelationValues, reportSectionBudgets, setRelationValues } from './memory-maintenance';
import { analyzeMood } from './mood';
import { mergeMood, needsAiVerification, verifyMoodWithAI } from './mood-ai';
import {
  checkChannelOffline,
  diagnoseProactive,
  runProactiveNow,
  runWebProactiveRandom,
  runWebProactiveSlot,
} from './webproactive';
import { ackSent, dropMessages, markAttempt, queueStats, takePending } from './queue';
import { openaiApp, stripAttachmentWrapper } from './openai';
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
import { readEngineMetrics } from './engine-metrics';
import { applyEventsToVector, extractEmotionEvents, reconcileWithApology, type EmotionEvent } from './emotion-events';
import { buildEmotionSnapshot, describeEmotionState } from './emotion-snapshot';
import { decayEmotion, emptyEmotionVector, type EmotionVector } from './emotion-vector';
import { elapsedMs, logTrace, REQUEST_ID_HEADER, shouldLogHttp, startTrace } from './trace';
import { deleteRuntimeState, getRuntimeState, putRuntimeState } from './runtime-store';
import { getHeartbeat } from './profile-cache';

type AppEnv = { Bindings: Env; Variables: { requestId: string } };
const app = new Hono<AppEnv>();

// Phase 0 可观测性：每个请求带 request-id；只记录关键路径/错误，避免轮询刷屏。
app.use('*', async (c, next) => {
  const trace = startTrace(c.req.header(REQUEST_ID_HEADER));
  c.set('requestId', trace.requestId);
  c.header(REQUEST_ID_HEADER, trace.requestId);
  await next();
  const status = c.res.status;
  if (shouldLogHttp(c.req.path, status)) {
    logTrace('http', {
      requestId: trace.requestId,
      method: c.req.method,
      path: c.req.path,
      status,
      ms: elapsedMs(trace),
    });
  }
});

const AUTH_KV_PREFIX = 'auth:';
const AUTH_TTL_SECONDS = AUTH_TOKEN_TTL_SECONDS;

function authSecret(env: Env): string | null {
  return env.AUTH_SECRET?.trim() || env.ACCESS_PASSWORD_HASH?.trim() || null;
}

function authMode(env: Env): 'signed' | 'kv' {
  return (env.AUTH_MODE ?? 'signed').toLowerCase() === 'kv' ? 'kv' : 'signed';
}

/** QQ 客户端心跳（D1 runtime_state，用于判断通道是否还活着）。 */
const HEARTBEAT_KV_KEY = 'proactive:heartbeat';
const HEARTBEAT_TTL_SECONDS = 7 * 24 * 60 * 60;
/** 超过这么久没心跳就算离线（客户端 5 分钟一次）。 */
const HEARTBEAT_ONLINE_SECONDS = 15 * 60;

/** 登录校验：signed 优先（无 KV 读）；kv 模式保留为回滚路径。 */
async function requireAuth(c: Context<AppEnv>, next: Next) {
  const token = getCookie(c, 'ds_token');
  if (!token) return c.json({ error: '未登录或会话已过期' }, 401);

  const secret = authSecret(c.env);
  if (authMode(c.env) === 'kv' || !secret) {
    const ok = (await c.env.KV.get(`${AUTH_KV_PREFIX}${token}`)) === '1';
    if (!ok) return c.json({ error: '未登录或会话已过期' }, 401);
    await next();
    return;
  }

  const payload = await verifyAuthToken(token, secret);
  if (!payload) return c.json({ error: '未登录或会话已过期' }, 401);
  if (await isAuthTokenRevoked(c.env, payload)) {
    return c.json({ error: '会话已失效，请重新登录' }, 401);
  }
  await next();
}

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

/** 当天上下文预览（含天气）。 */
app.get('/api/day', async (c) => {
  const ctx = buildDayContext(dateKeyInBeijing());
  const cfg = await getCityConfig(c.env);
  const weather = await fetchWeather(c.env);
  return c.json({ ...ctx, city: cfg.city, weather });
});

/** DeepSeek 账户余额（代理官方接口，密钥不出服务端）。 */
app.get('/api/balance', requireAuth, async (c) => {
  const apiKey = c.env.DEEPSEEK_API_KEY;
  if (!apiKey) return c.json({ error: 'DEEPSEEK_API_KEY 未配置' }, 500);
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
    return c.json({
      available: data.is_available ?? false,
      currency: info?.currency ?? 'CNY',
      total: Number(info?.total_balance ?? 0),
      granted: Number(info?.granted_balance ?? 0),
      topped_up: Number(info?.topped_up_balance ?? 0),
    });
  } catch (e) {
    console.error('[balance] fetch failed:', e);
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

/** 历史消息读取时兜底清洗平台包装（AstrBot 文件附件等），顺带兼容修复前落库的旧数据。 */
function sanitizeStoredMessages<T extends { content: string }>(rows: T[]): T[] {
  return rows.map((m) => ({ ...m, content: stripAttachmentWrapper(m.content) }));
}

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

/** 聊天图片回放（需登录；图片存在 R2 images/ 下，主账号优先、小号兜底）。 */
app.get('/api/image/*', requireAuth, async (c) => {
  const key = decodeURIComponent(c.req.path.replace(/^\/api\/image\//, ''));
  if (!key.startsWith('images/')) return c.json({ error: 'not found' }, 404);
  const obj = await getObject(c.env, key);
  if (!obj) return c.json({ error: 'not found' }, 404);
  return new Response(await obj.arrayBuffer(), {
    headers: {
      'content-type': obj.httpMetadata?.contentType ?? 'application/octet-stream',
      'cache-control': 'private, max-age=86400',
    },
  });
});

/** 增量拉取（实时刷新用）：?after_id=<已知最大编号>&limit=50，升序返回比它新的消息。
 *  前端定时轮询此接口，实现 QQ / 其它渠道消息在网页端“实时出现”。
 */
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
/** Phase 2：查看 Memory Context 表规模。 */
app.get('/api/admin/memory/context-stats', requireAuth, async (c) => {
  return c.json({ ok: true, ...(await memoryContextStats(c.env)) });
});
/** Phase 5 观察：按天读取 shadow/next 指标（不记录正文）。 */
app.get('/api/admin/engine-metrics', requireAuth, async (c) => {
  const days = Math.min(30, Math.max(1, Number(c.req.query('days') ?? 7) || 7));
  const rows = await readEngineMetrics(c.env, days);
  return c.json({ ok: true, days, rows });
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
      memory_engine_web: c.env.MEMORY_ENGINE_WEB ?? c.env.MEMORY_ENGINE ?? 'legacy',
      affect_engine_qq: c.env.AFFECT_ENGINE_QQ ?? c.env.AFFECT_ENGINE ?? 'legacy',
      affect_engine_web: c.env.AFFECT_ENGINE_WEB ?? c.env.AFFECT_ENGINE ?? 'legacy',
      auth_secret_configured: Boolean(c.env.AUTH_SECRET),
      memory_bytes: memoryBytes,
      context,
      jobs,
      warnings,
    },
    ready ? 200 : 503,
  );
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
    recent_memo_items: memo ? memo.text.split('\n').filter((l) => l.trim().startsWith('- ')).length : 0,
    archive_lines: archiveLines.length,
    archive_bytes: byteLength(archiveLines.join('\n')),
    chat_log_files: logKeys.length,
    storage_mode: await getStorageMode(c.env),
    recent_jobs: runs.results ?? [],
  });
});

// —— OpenAI 兼容端点（AstrBot 等第三方接入）——
app.route('/v1', openaiApp);

/* ---------- 主动消息队列（反向轮询：客户端拉取） ---------- */

/** Bearer 鉴权（复用 ASTROBOT_API_KEY）。 */
async function checkQueueAuth(c: Context<AppEnv>): Promise<boolean> {
  const expected = c.env.ASTROBOT_API_KEY;
  if (!expected) return false;
  const auth = c.req.header('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  return token.length > 0 && token === expected;
}

/** 拉取待发送的主动消息。 */
app.get('/api/proactive/pending', async (c) => {
  if (!(await checkQueueAuth(c))) return c.json({ error: 'unauthorized' }, 401);
  const limitRaw = Number(c.req.query('limit') ?? '5');
  const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 5, 1), 20);
  const messages = await takePending(c.env, limit);
  // ★ 不再在拉取时计尝试次数：拉取不代表发送。失败由插件调 /nack 上报，
  //   否则「插件发送失败 / UMO 失效」会静默地把消息在 5 分钟后丢掉。
  return c.json({ messages });
});

/** 上报发送失败（插件调用）：attempts+1，5 次后不再下发。 */
app.post('/api/proactive/nack', async (c) => {
  if (!(await checkQueueAuth(c))) return c.json({ error: 'unauthorized' }, 401);
  const body = await c.req.json().catch(() => null);
  const ids = body && Array.isArray(body.ids) ? body.ids.filter((x: unknown) => typeof x === 'number') : [];
  await markAttempt(c.env, ids);
  return c.json({ ok: true, failed: ids.length });
});

/** 确认已发送。 */
app.post('/api/proactive/ack', async (c) => {
  if (!(await checkQueueAuth(c))) return c.json({ error: 'unauthorized' }, 401);
  const body = await c.req.json().catch(() => null);
  const ids = body && Array.isArray(body.ids) ? body.ids.filter((x: unknown) => typeof x === 'number') : [];
  const acked = await ackSent(c.env, ids);
  return c.json({ ok: true, acked });
});

/** 队列状态（供调试）。 */
app.get('/api/proactive/stats', requireAuth, async (c) => {
  const stats = await queueStats(c.env);
  const hb = await getHeartbeat(c.env);
  const ageSeconds = hb?.at ? (Date.now() - Date.parse(hb.at)) / 1000 : null;
  return c.json({
    ...stats,
    // ★ QQ 通道可见性：手机杀后台后客户端会静默消失，只能靠心跳判断
    heartbeat: hb,
    heartbeat_age_seconds: ageSeconds,
    paused_until: await getRuntimeState(c.env, 'proactive:paused_until').catch(() => null),
    channel_online: ageSeconds !== null && ageSeconds < HEARTBEAT_ONLINE_SECONDS,
  });
});

/** 积压保护：主动丢弃过期消息（不算送达）。 */
app.post('/api/proactive/drop', async (c) => {
  if (!(await checkQueueAuth(c))) return c.json({ error: 'unauthorized' }, 401);
  const body = await c.req.json().catch(() => null);
  const ids = body && Array.isArray(body.ids) ? body.ids.filter((x: unknown) => typeof x === 'number') : [];
  const dropped = await dropMessages(c.env, ids);
  return c.json({ ok: true, dropped });
});

/** 手动补发一条固定时段主动消息（Bearer 鉴权，调试/补偿用）。 */
app.post('/api/admin/proactive-send-now', async (c) => {
  if (!(await checkQueueAuth(c))) return c.json({ error: 'unauthorized' }, 401);
  const body = (await c.req.json().catch(() => null)) as { kind?: unknown } | null;
  const kind = body?.kind === 'morning' ? 'morning' : 'evening';
  return c.json(await runProactiveNow(c.env, new Date(), kind));
});

/** 诊断：为什么现在（没）会发主动消息。只读，不发送、不写库。 */
app.post('/api/admin/proactive-diagnose', async (c) => {
  if (!(await checkQueueAuth(c))) return c.json({ error: 'unauthorized' }, 401);
  const now = new Date();
  return c.json(await diagnoseProactive(c.env, now));
});

/** 暂停主动消息（/退订）：days=0 表示恢复。 */
app.post('/api/proactive/pause', async (c) => {
  if (!(await checkQueueAuth(c))) return c.json({ error: 'unauthorized' }, 401);
  const body = (await c.req.json().catch(() => null)) as { days?: unknown } | null;
  const days = Math.min(30, Math.max(0, Number(body?.days ?? 7) || 0));
  if (days === 0) {
    await deleteRuntimeState(c.env, 'proactive:paused_until').catch(() => {});
    return c.json({ ok: true, paused_until: null });
  }
  const until = new Date(Date.now() + days * 86400000).toISOString();
  await putRuntimeState(c.env, 'proactive:paused_until', until, days * 86400 + 3600);
  return c.json({ ok: true, paused_until: until });
});

/** 客户端心跳：让 Worker 知道 QQ 通道还在。 */
app.post('/api/proactive/heartbeat', async (c) => {
  if (!(await checkQueueAuth(c))) return c.json({ error: 'unauthorized' }, 401);
  const body = (await c.req.json().catch(() => null)) as {
    connected?: unknown;
    queue_depth?: unknown;
    version?: unknown;
    last_error?: unknown;
  } | null;
  const payload = {
    at: new Date().toISOString(),
    connected: body?.connected === true,
    queue_depth: typeof body?.queue_depth === 'number' ? body.queue_depth : null,
    version: typeof body?.version === 'string' ? body.version.slice(0, 40) : null,
    last_error: typeof body?.last_error === 'string' ? body.last_error.slice(0, 200) : null,
  };
  await putRuntimeState(c.env, HEARTBEAT_KV_KEY, JSON.stringify(payload), HEARTBEAT_TTL_SECONDS);
  return c.json({ ok: true });
});

/** 手动触发一次网页端主动消息（测试用）。 */
app.post('/api/admin/trigger-proactive', requireAuth, async (c) => {
  const body = await c.req.json().catch(() => null);
  const kind = body && body.kind === 'random' ? 'random' : 'slot';
  const now = new Date();
  const result =
    kind === 'random' ? await runWebProactiveRandom(c.env, now) : await runWebProactiveSlot(c.env, now);
  return c.json({ ok: true, kind, ...result });
});

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
  return new Response(replaced, {
    // 内容长度已变，去掉沿袭自上游的 content-length，避免响应被截断
    headers: new Headers(
      [...upstream.headers].filter(([k]) => k.toLowerCase() !== 'content-length'),
    ),
    status: upstream.status,
  });
});

app.onError((err, c) => {
  console.error('[worker] unhandled error:', err);
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
  if (now.getUTCMinutes() >= 5) return;
  const hour = now.getUTCHours();
  if (hour !== 0 && hour !== 8 && hour !== 16) return;
  await runContextRefresh(env, now);
}

async function runChannelCheck(env: Env, now: Date): Promise<void> {
  const result = await checkChannelOffline(env, now).catch(() => 'skip' as const);
  if (result === 'alerted') console.warn('[cron] QQ 通道掉线，已入队提醒');
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
        })(),
      );
      return;
    }

    if (cron === '*/5 1-14 * * *') {
      // QQ 通道掉线检查：与主动消息是否暂停无关，每次 tick 都查
      ctx.waitUntil(runChannelCheck(env, now));
      // 白天随机主动消息：打分决策 + 落库 + 推送 QQ（直连或队列）
      ctx.waitUntil(runWebProactiveRandom(env, now));
      // 这条 cron 实际覆盖 UTC 8 点 → 北京 16:00 的 context 刷新
      ctx.waitUntil(maybeRefreshContext(env, now));
      return;
    }

    if (cron === '*/5 23,0,14,15,16 * * *') {
      // QQ 通道掉线检查（同上）
      ctx.waitUntil(runChannelCheck(env, now));
      // 早晚固定主动消息：打分决策 + 落库 + 推送 QQ（直连或队列）
      ctx.waitUntil(runWebProactiveSlot(env, now));
      // 这条 cron 覆盖 UTC 0 / 16 点 → 北京 08:00 / 24:00 的 context 刷新
      ctx.waitUntil(maybeRefreshContext(env, now));
      return;
    }

    console.warn('[cron] unknown cron expression:', cron);
  },
} satisfies ExportedHandler<Env>;
