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
  checkChannelOffline,
  diagnoseProactive,
  runProactiveNow,
  runWebProactiveRandom,
  runWebProactiveSlot,
} from './webproactive';
import { ackSent, dropMessages, markAttempt, queueStats, takePending } from './queue';
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
import { pruneRequestLog, readPathStats, readRecentRequests, recordRequest } from './request-log';
import { deleteRuntimeState, getRuntimeState, putRuntimeState } from './runtime-store';
import { getHeartbeat } from './profile-cache';

type AppEnv = { Bindings: Env; Variables: { requestId: string } };

const BILI_MIXIN_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

function biliSign(params: Record<string, string | number>, mixinKey: string) {
  const signed: Record<string, string | number> = { ...params, wts: Math.floor(Date.now() / 1000) };
  const cleaned: Record<string, string> = {};
  for (const [k, v] of Object.entries(signed)) {
    cleaned[k] = String(v).replace(/[!'()*]/g, '');
  }
  const query = Object.keys(cleaned).sort().map((k) =>
    `${encodeURIComponent(k)}=${encodeURIComponent(cleaned[k])}`
  ).join('&');
  return `${query}&w_rid=${SparkMD5.hash(query + mixinKey)}`;
}

async function biliMixinKey(headers: Record<string, string>): Promise<string | null> {
  try {
    const nav = await fetch('https://api.bilibili.com/x/web-interface/nav', { headers });
    const json = await nav.json() as { data?: { wbi_img?: { img_url?: string; sub_url?: string } } };
    const wbi = json.data?.wbi_img;
    if (!wbi?.img_url || !wbi.sub_url) return null;
    const img = wbi.img_url.split('/').pop()?.split('.')[0] ?? '';
    const sub = wbi.sub_url.split('/').pop()?.split('.')[0] ?? '';
    const orig = img + sub;
    return BILI_MIXIN_TAB.map((i) => orig[i] ?? '').join('').slice(0, 32);
  } catch {
    return null;
  }
}
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


/** QQ 客户端心跳（D1 runtime_state，用于判断通道是否还活着）。 */
const HEARTBEAT_KV_KEY = 'proactive:heartbeat';
const HEARTBEAT_TTL_SECONDS = 7 * 24 * 60 * 60;
/** 超过这么久没心跳就算离线（客户端 5 分钟一次）。 */
const HEARTBEAT_ONLINE_SECONDS = 15 * 60;

const PAIR_CODE_KV_KEY = 'pair:code';

async function loadPairCode(env: Env): Promise<string | null> {
  const stored = await env.KV.get(PAIR_CODE_KV_KEY).catch(() => null);
  if (stored && stored.trim()) return stored.trim();
  return env.APP_PAIR_CODE || env.ASTROBOT_API_KEY || null;
}

/** 配对码只允许字母数字，长度 8~32；返回 null 表示不合法。 */
function sanitizePairCode(raw: string): string | null {
  const code = raw.trim();
  if (!/^[A-Za-z0-9]{8,32}$/.test(code)) return null;
  return code;
}

/** 一次性配对码换设备 Token；配对码优先网页设置（KV），未配置时回退环境变量。 */
app.post('/api/app/pair', async (c) => {
  const body = await c.req.json().catch(() => null) as {
    pair_code?: unknown;
    device_name?: unknown;
    device_id?: unknown;
  } | null;
  const pairCode = body && typeof body.pair_code === 'string' ? body.pair_code : '';
  const expected = await loadPairCode(c.env);
  if (!expected) return c.json({ error: 'pair_not_configured' }, 503);
  if (!pairCode || pairCode !== expected) return c.json({ error: 'invalid_pair_code' }, 401);

  const token = randomHex(32);
  const deviceName = body && typeof body.device_name === 'string' ? body.device_name.slice(0, 80) : '';
  const deviceId = body && typeof body.device_id === 'string' ? body.device_id.slice(0, 120) : '';
  await c.env.KV.put(
    `app:device:${token}`,
    JSON.stringify({ device_name: deviceName, device_id: deviceId, created_at: isoInBeijing() }),
    { expirationTtl: 365 * 24 * 3600 },
  );
  return c.json({
    ok: true,
    token,
    expires_at: new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString(),
  });
});

// ── 配对码管理（网页端设置，走 KV，不用重新部署） ──────────────────

app.get('/api/admin/pair-code', requireAuth, async (c) => {
  const stored = await c.env.KV.get(PAIR_CODE_KV_KEY).catch(() => null);
  const effective = await loadPairCode(c.env);
  return c.json({
    code: effective,
    source: stored && stored.trim() ? 'web' : (c.env.APP_PAIR_CODE ? 'env' : 'fallback'),
    editable: true,
  });
});

app.post('/api/admin/pair-code', requireAuth, async (c) => {
  const body = await c.req.json().catch(() => null) as { code?: unknown } | null;
  const raw = body && typeof body.code === 'string' ? body.code : null;
  if (raw === null) return c.json({ error: 'invalid_body' }, 400);
  // 空字符串 = 清掉网页设置，回退到环境变量里的那个
  if (raw.trim() === '') {
    await c.env.KV.delete(PAIR_CODE_KV_KEY);
    return c.json({ ok: true, code: await loadPairCode(c.env), source: 'env' });
  }
  const code = sanitizePairCode(raw);
  if (!code) return c.json({ error: 'invalid_code', hint: '8~32 位字母或数字' }, 400);
  await c.env.KV.put(PAIR_CODE_KV_KEY, code);
  return c.json({ ok: true, code, source: 'web' });
});

/** App 心跳：让 Worker 知道移动端在线，避免误发“QQ 通道掉线”。 */
app.post('/api/app/heartbeat', requireApp, async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    connected?: unknown;
    version?: unknown;
    last_error?: unknown;
  } | null;
  const payload = {
    at: new Date().toISOString(),
    connected: body?.connected !== false,
    queue_depth: 0,
    version: typeof body?.version === 'string' ? body.version.slice(0, 40) : 'ds-mobile',
    last_error: typeof body?.last_error === 'string' ? body.last_error.slice(0, 200) : null,
  };
  await putRuntimeState(c.env, HEARTBEAT_KV_KEY, JSON.stringify(payload), HEARTBEAT_TTL_SECONDS);
  return c.json({ ok: true });
});

/** App 主动纠正记忆：/更正 职业=... / /更正 我叫...。 */
app.post('/api/app/memory/correct', requireApp, async (c) => {
  const body = (await c.req.json().catch(() => null)) as { text?: unknown } | null;
  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  if (!text) return c.json({ error: 'text required' }, 400);
  try {
    const result = await applyMemoryCorrection(c.env, text);
    return c.json(result);
  } catch (e) {
    return c.json({ error: String(e) }, 500);
  }
});

/** App 主动更新位置：用户点击定位并确认后写入记忆。 */
app.post('/api/app/location', requireApp, async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    latitude?: unknown;
    longitude?: unknown;
    accuracy?: unknown;
    reason?: unknown;
  } | null;
  const lat = Number(body?.latitude);
  const lng = Number(body?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return c.json({ error: 'invalid coordinates' }, 400);
  }
  const accuracy = Number(body?.accuracy);
  const reasonRaw = typeof body?.reason === 'string' ? body.reason.trim().slice(0, 120) : '';
  const reason = reasonRaw || '用户主动更新位置';
  const accuracyText = Number.isFinite(accuracy) && accuracy > 0 ? `（精度约 ${Math.round(accuracy)}m）` : '';
  const text = `当前位置=${lat.toFixed(5)},${lng.toFixed(5)}${accuracyText}；位置变更原因=${reason}；更新时间=${isoInBeijing()}`;
  try {
    const result = await applyMemoryCorrection(c.env, text);
    return c.json(result);
  } catch (e) {
    return c.json({ error: String(e) }, 500);
  }
});

/** App 增量消息：所有渠道，按 id 升序；客户端自己按 id 去重。 */
app.get('/api/app/events', requireApp, async (c) => {
  const rawAfter = Number(c.req.query('after_id') ?? '');
  const afterId = Number.isFinite(rawAfter) && rawAfter >= 0 ? Math.floor(rawAfter) : 0;
  const rawLimit = Number(c.req.query('limit') ?? '50');
  const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 50, 1), 100);
  const latest = c.req.query('latest') === '1';
  const rawBefore = Number(c.req.query('before_id') ?? '');
  const beforeId = Number.isFinite(rawBefore) && rawBefore > 0 ? Math.floor(rawBefore) : 0;
  let messages: MessageRow[] = [];
  let hasMore = false;
  if (latest) {
    const page = await messagesPage(c.env, { limit });
    messages = page.messages;
    hasMore = page.hasMore;
  } else if (beforeId > 0) {
    const minRow = await c.env.DB.prepare('SELECT MIN(id) AS id FROM messages').first<{ id: number | null }>();
    const minId = Number(minRow?.id) || 0;
    if (!minId || beforeId < minId) {
      // 请求已经越过 D1 的最早边界：直接从 R2 归档继续。
      const archived = await archivedMessagesBefore(c.env, beforeId, limit);
      messages = archived.messages;
      hasMore = archived.hasMore;
    } else {
      const page = await messagesPage(c.env, { beforeId, limit });
      messages = page.messages;
      hasMore = page.hasMore;
      // D1 本页已到边界但还没满一页时，用 R2 归档补齐更早的消息。
      if (messages.length < limit) {
        const archived = await archivedMessagesBefore(c.env, minId, limit - messages.length);
        if (archived.messages.length > 0) {
          messages = [...archived.messages, ...messages];
          hasMore = archived.hasMore || hasMore;
        }
      }
    }
  } else {
    const page = await messagesSince(c.env, afterId, limit);
    messages = page.messages;
    hasMore = page.hasMore;
  }
  const payload = messages.map((m) => ({
    id: m.id,
    role: m.role,
    content: m.content,
    channel: m.channel,
    created_at: m.created_at,
    turn_id: m.turn_id,
    proactive_kind: m.proactive_kind,
    client_message_id: m.client_message_id,
  }));
  return c.json({
    messages: sanitizeStoredMessages(payload),
    latest_id: messages.length > 0 ? messages[messages.length - 1].id : afterId,
    has_more: hasMore,
  });
});

/** App pending 对账：按 client_message_id 查服务端是否已经落库。 */
app.get('/api/app/client-messages', requireApp, async (c) => {
  const ids = (c.req.query('ids') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.length <= 100)
    .slice(0, 20);
  if (ids.length === 0) return c.json({ messages: [] });
  const placeholders = ids.map(() => '?').join(',');
  const rows = await c.env.DB.prepare(
    `SELECT * FROM messages WHERE client_message_id IN (${placeholders}) ORDER BY id ASC LIMIT 40`,
  )
    .bind(...ids)
    .all<MessageRow>();
  const payload = (rows.results ?? []).map((m) => ({
    id: m.id,
    role: m.role,
    content: m.content,
    channel: m.channel,
    created_at: m.created_at,
    turn_id: m.turn_id,
    proactive_kind: m.proactive_kind,
    client_message_id: m.client_message_id,
  }));
  return c.json({ messages: sanitizeStoredMessages(payload) });
});

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

/**
 * 原图直传（QQ 大 GIF 用）：Bearer 鉴权，raw binary → R2，不压缩。
 * 避免把 6MB 图片 base64 塞进 8MB JSON 后在 TLS 层断连。
 */
app.post('/api/upload/image', async (c) => {
  if (!(await checkQueueAuth(c))) return c.json({ error: 'unauthorized' }, 401);
  const mime = (c.req.header('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (!/^image\/(gif|png|jpe?g|webp)$/.test(mime)) {
    return c.json({ error: 'unsupported image type' }, 415);
  }
  const maxBytes = 20 * 1024 * 1024;
  const declared = Number(c.req.header('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > maxBytes) {
    return c.json({ error: 'image too large' }, 413);
  }
  const buf = new Uint8Array(await c.req.arrayBuffer());
  if (buf.length === 0 || buf.length > maxBytes) {
    return c.json({ error: 'image too large' }, 413);
  }
  const ext = mime === 'image/jpeg' ? 'jpg' : mime.split('/')[1];
  const dateKey = dateKeyInBeijing(new Date());
  const key = buildImageKey(dateKey, Date.now(), ext);
  await putObject(c.env, key, buf, { contentType: mime });
  return c.json({ ok: true, key, mime, bytes: buf.length });
});

/** 语音直传（手机端收到 QQ 语音后转码 MP3，再上传）。 */
app.post('/api/upload/audio', async (c) => {
  if (!(await checkQueueAuth(c))) return c.json({ error: 'unauthorized' }, 401);
  const mime = (c.req.header('content-type') ?? '').split(';')[0].trim().toLowerCase();
  const allowed: Record<string, string> = {
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/ogg': 'ogg',
    'audio/opus': 'opus',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/mp4': 'm4a',
    'audio/aac': 'aac',
    'audio/webm': 'webm',
  };
  const ext = allowed[mime];
  if (!ext) return c.json({ error: 'unsupported audio type' }, 415);
  const maxBytes = 10 * 1024 * 1024;
  const declared = Number(c.req.header('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > maxBytes) {
    return c.json({ error: 'audio too large' }, 413);
  }
  const buf = new Uint8Array(await c.req.arrayBuffer());
  if (buf.length === 0 || buf.length > maxBytes) {
    return c.json({ error: 'audio too large' }, 413);
  }
  const key = buildAudioKey(dateKeyInBeijing(new Date()), Date.now(), ext);
  await putObject(c.env, key, buf, { contentType: mime });
  return c.json({ ok: true, key, mime, bytes: buf.length });
});

/** 网页创建 TTS 任务：手机优先，网页轮询；超时走 fallback。 */
app.post('/api/tts', requireAuth, async (c) => {
  const body = (await c.req.json().catch(() => null)) as { text?: unknown } | null;
  const text = typeof body?.text === 'string' ? body.text.trim().slice(0, 300) : '';
  if (!text) return c.json({ error: 'text 不能为空' }, 400);
  const jobId = await createTtsJob(c.env, text);
  if (!jobId) return c.json({ error: '创建任务失败' }, 500);
  return c.json({ ok: true, job_id: jobId, status: 'pending' });
});

/** 网页轮询 TTS 任务。 */
app.get('/api/tts/jobs/:id', requireAuth, async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isFinite(id)) return c.json({ error: 'invalid id' }, 400);
  const job = await getTtsJob(c.env, id);
  if (!job) return c.json({ error: 'not found' }, 404);
  return c.json({ ok: true, id: job.id, status: job.status, audio_key: job.audio_key });
});

/** 手机超时后由网页触发 MeloTTS 兜底。 */
app.post('/api/tts/jobs/:id/fallback', requireAuth, async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isFinite(id)) return c.json({ error: 'invalid id' }, 400);
  const key = await fallbackTtsJob(c.env, id).catch(() => null);
  if (!key) return c.json({ error: 'TTS 兜底失败' }, 502);
  return c.json({ ok: true, id, status: 'done', audio_key: key });
});

/** 手机拉取一个待合成任务。 */
app.get('/api/tts/pending', async (c) => {
  if (!(await checkQueueAuth(c))) return c.json({ error: 'unauthorized' }, 401);
  const job = await claimTtsJob(c.env);
  return c.json({ ok: true, job });
});

/** 手机合成完成：回传 R2 key。 */
app.post('/api/tts/ack', async (c) => {
  if (!(await checkQueueAuth(c))) return c.json({ error: 'unauthorized' }, 401);
  const body = (await c.req.json().catch(() => null)) as { id?: unknown; audio_key?: unknown } | null;
  const id = Number(body?.id);
  const key = typeof body?.audio_key === 'string' ? body.audio_key : '';
  if (!Number.isFinite(id) || !key) return c.json({ error: 'bad request' }, 400);
  await ackTtsJob(c.env, id, key);
  return c.json({ ok: true });
});

/** 手机合成失败：重试或让网页走兜底。 */
app.post('/api/tts/nack', async (c) => {
  if (!(await checkQueueAuth(c))) return c.json({ error: 'unauthorized' }, 401);
  const body = (await c.req.json().catch(() => null)) as { id?: unknown } | null;
  const id = Number(body?.id);
  if (!Number.isFinite(id)) return c.json({ error: 'bad request' }, 400);
  await nackTtsJob(c.env, id);
  return c.json({ ok: true });
});

/** 聊天语音回放（需登录；audio/ 下，主账号优先、小号兜底）。 */
app.get('/api/audio/*', requireAuth, async (c) => {
  const key = decodeURIComponent(c.req.path.replace(/^\/api\/audio\//, ''));
  // audio/ 是 App 上传的音频；tts/ 是服务端合成的缓存（见 tts-config.ts）
  if (!key.startsWith('audio/') && !key.startsWith('tts/')) {
    return c.json({ error: 'not found' }, 404);
  }
  const obj = await getObject(c.env, key);
  if (!obj) return c.json({ error: 'not found' }, 404);
  return new Response(await obj.arrayBuffer(), {
    headers: {
      'content-type': obj.httpMetadata?.contentType ?? 'audio/mpeg',
      'cache-control': 'private, max-age=86400',
      'accept-ranges': 'bytes',
    },
  });
});

/** 普通网页/抖音链接预览：只抓标题和描述，限制内网地址。 */
app.get('/api/app/web-preview', requireApp, async (c) => {
  const raw = c.req.query('url') ?? '';
  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return c.json({ error: 'invalid url' }, 400);
  }
  if (!/^https?:$/.test(target.protocol)) return c.json({ error: 'invalid protocol' }, 400);
  const host = target.hostname.toLowerCase();
  if (
    host === 'localhost' || host.endsWith('.local') ||
    /^(?:127\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(host) ||
    host === '[::1]'
  ) {
    return c.json({ error: 'private host' }, 400);
  }
  try {
    const ua = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/125.0 Mobile Safari/537.36';
    const response = await fetch(target.toString(), {
      headers: { 'User-Agent': ua, Accept: 'text/html,application/xhtml+xml' },
      redirect: 'follow',
    });
    const html = (await response.text()).slice(0, 2_000_000);
    const meta = (name: string): string => {
      const a = html.match(new RegExp(
        `<meta[^>]+(?:property|name)=["']${name}["'][^>]+content=["']([^"']*)`,
        'i',
      ));
      const b = html.match(new RegExp(
        `<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${name}["']`,
        'i',
      ));
      return a?.[1] ?? b?.[1] ?? '';
    };
    const title = (meta('og:title') || html.match(/<title>([^<]+)<\/title>/i)?.[1] || '')
      .replace(/\s+/g, ' ').trim().slice(0, 200);
    const description = (meta('og:description') || meta('description') || '')
      .replace(/\s+/g, ' ').trim().slice(0, 500);
    return c.json({
      title,
      description,
      site: target.hostname,
      douyin: /douyin\.com$/i.test(host),
    });
  } catch {
    return c.json({ error: 'preview failed' }, 502);
  }
});

/** B 站短链/视频链接预览：只允许 B 站域名，避免变 SSRF。 */
app.get('/api/app/link-preview', requireApp, async (c) => {
  try {
    const raw = c.req.query('url') ?? '';
    if (!/^https?:\/\/(?:b23\.tv|(?:www\.)?bilibili\.com)\//i.test(raw)) {
      return c.json({ error: 'unsupported url' }, 400);
    }
    const ua = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/125.0 Mobile Safari/537.36';
    let target = raw;
    if (/b23\.tv/i.test(raw)) {
      const redirect = await fetch(raw, { redirect: 'follow', headers: { 'User-Agent': ua } });
      target = redirect.url;
    }
    const m = target.match(/\/video\/(BV[0-9A-Za-z]+)/i) ??
      target.match(/[?&]bvid=(BV[0-9A-Za-z]+)/i);
    if (!m) return c.json({ error: 'not a video url', target }, 404);
    const bvid = m[1];
    let title = '';
    let owner = '';
    let duration = 0;
    let desc = '';
    let aid = 0;
    let cid = 0;
    let upMid = 0;
    let cover = '';
    const cookie: Record<string, string> = c.env.BILIBILI_SESSDATA
      ? { Cookie: `SESSDATA=${c.env.BILIBILI_SESSDATA}` }
      : {};
    try {
      const api = await fetch(
        `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`,
        {
          headers: {
            'User-Agent': ua,
            Referer: 'https://www.bilibili.com/',
            Accept: 'application/json',
            ...cookie,
          },
        },
      );
      const text = await api.text();
      if (text.trim().startsWith('{')) {
        const json = JSON.parse(text) as {
          code?: number;
          data?: {
            title?: string;
            desc?: string;
            duration?: number;
            aid?: number;
            cid?: number;
            pic?: string;
            owner?: { name?: string; mid?: number };
            pages?: Array<{ cid?: number }>;
          };
        };
        if (json.code === 0 && json.data) {
          title = json.data.title || '';
          owner = json.data.owner?.name || '';
          duration = json.data.duration || 0;
          desc = (json.data.desc || '').replace(/\s+/g, ' ').trim().slice(0, 500);
          aid = Number(json.data.aid || 0);
          cid = Number(json.data.cid || json.data.pages?.[0]?.cid || 0);
          upMid = Number(json.data.owner?.mid || 0);
          cover = (json.data.pic || '').replace(/^http:/, 'https:');
        }
      }
    } catch {
      // API 被 WAF 拦截时走页面 meta 兜底
    }
    if (!title) {
      try {
        const page = await fetch(target, {
          headers: { 'User-Agent': ua, Referer: 'https://www.bilibili.com/' },
        });
        const html = await page.text();
        const meta = (name: string): string => {
          const a = html.match(new RegExp(
            `<meta[^>]+(?:property|name)=["']${name}["'][^>]+content=["']([^"']*)`,
            'i',
          ));
          const b = html.match(new RegExp(
            `<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${name}["']`,
            'i',
          ));
          return a?.[1] ?? b?.[1] ?? '';
        };
        title = meta('og:title') || meta('title');
        owner = meta('author') || meta('og:site_name') || '';
        desc = (meta('og:description') || meta('description')).replace(/\s+/g, ' ').trim().slice(0, 500);
        duration = Number(html.match(/"duration":(\d+)/)?.[1] ?? 0) || 0;
        if (!title) {
          const t = html.match(/<title>([^<]+)<\/title>/i)?.[1] ?? '';
          title = t.replace(/_哔哩哔哩.*$/i, '').trim();
        }
      } catch {
        // 保留空标题，App 显示短链兜底
      }
    }
    if (!title || /出错啦|页面不存在|404/i.test(title)) {
      return c.json({ error: 'preview unavailable', bvid }, 502);
    }

    let summary = '';
    let outline: string[] = [];
    let subtitle = '';
    let subtitleCount = 0;
    if (cookie.Cookie && cid) {
      const headers = {
        'User-Agent': ua,
        Referer: 'https://www.bilibili.com/',
        Accept: 'application/json',
        ...cookie,
      };
      const mixinKey = await biliMixinKey(headers);
      if (mixinKey) {
        try {
          const params = biliSign({ aid, cid }, mixinKey);
          const player = await fetch(
            `https://api.bilibili.com/x/player/wbi/v2?${params}`,
            { headers },
          );
          const pj = await player.json() as {
            data?: { subtitle?: { subtitles?: Array<{ lan?: string; subtitle_url?: string }> } };
          };
          const subs = pj.data?.subtitle?.subtitles ?? [];
          const zh = subs.find((s) => /^(zh|ai)/i.test(s.lan ?? '')) ?? subs[0];
          if (zh?.subtitle_url) {
            const url = zh.subtitle_url.startsWith('//') ? `https:${zh.subtitle_url}` : zh.subtitle_url;
            const sr = await fetch(url, { headers });
            const sj = await sr.json() as { body?: Array<{ content?: string }> };
            const lines = (sj.body ?? []).map((x) => (x.content ?? '').trim()).filter(Boolean);
            subtitleCount = lines.length;
            subtitle = lines.join('\n');
          }
        } catch {
          // 字幕不可用时继续
        }
        try {
          const params = biliSign({ bvid, cid, up_mid: upMid }, mixinKey);
          const conclusion = await fetch(
            `https://api.bilibili.com/x/web-interface/view/conclusion/get?${params}`,
            { headers },
          );
          const cj = await conclusion.json() as {
            data?: {
              model_result?: {
                summary?: string;
                outline?: Array<{ title?: string; part_outline?: string[] }>;
              };
            };
          };
          const model = cj.data?.model_result;
          summary = (model?.summary ?? '').trim();
          for (const item of model?.outline ?? []) {
            const t = (item.title ?? '').trim();
            if (t) outline.push(t);
            for (const p of (item.part_outline ?? []).slice(0, 4)) {
              if (p.trim()) outline.push(`  · ${p.trim()}`);
            }
            if (outline.length >= 12) break;
          }
          outline = outline.slice(0, 12);
        } catch {
          // 官方总结不可用时用简介兜底
        }
      }
    }
    return c.json({
      bvid,
      title,
      owner,
      duration,
      desc,
      summary: summary || desc,
      outline,
      subtitle,
      subtitle_count: subtitleCount,
      cover,
    });
  } catch (e) {
    return c.json({ error: 'link preview failed', detail: String(e).slice(0, 200) }, 500);
  }
});

/**
 * App 图片回放：设备 Token 鉴权，只允许 images/ 前缀。
 */
/** App 视频/GIF 上传：原文件进 R2，聊天里只存 [视频:key]/[GIF:key]。 */
app.post('/api/app/upload/video', requireApp, async (c) => {
  const mime = (c.req.header('content-type') ?? '').split(';')[0].trim().toLowerCase();
  const allowed: Record<string, string> = {
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/quicktime': 'mov',
    'video/3gpp': '3gp',
    'image/gif': 'gif',
  };
  const ext = allowed[mime];
  if (!ext) return c.json({ error: 'unsupported media type' }, 415);
  const length = Number(c.req.header('content-length') ?? 0);
  if (!length || length > 60 * 1024 * 1024) return c.json({ error: 'media too large' }, 413);
  const kind = ext === 'gif' ? 'gifs' : 'videos';
  const date = new Date().toISOString().slice(0, 10);
  const key = `${kind}/${date}/${crypto.randomUUID()}.${ext}`;
  const bytes = await c.req.arrayBuffer();
  await c.env.R2.put(key, bytes, {
    httpMetadata: { contentType: mime, cacheControl: 'private, max-age=31536000' },
  });
  return c.json({ key, contentType: mime, size: bytes.byteLength });
});

/** App 视频/GIF 回放：设备 Token 鉴权，只允许 videos/、gifs/。 */
app.get('/api/app/media', requireApp, async (c) => {
  const key = c.req.query('key') ?? '';
  if (!/^(videos|gifs)\//.test(key) || key.length > 200 || key.includes('..')) {
    return c.json({ error: 'not found' }, 404);
  }
  const head = await c.env.R2.head(key);
  if (!head) return c.json({ error: 'not found' }, 404);
  const size = head.size;
  const etag = head.httpEtag;

  // 内容不可变（key 里带日期和 uuid），命中 ETag 直接 304，省掉整段重传。
  if (etag && c.req.header('if-none-match') === etag) {
    return new Response(null, { status: 304, headers: { etag } });
  }

  const range = parseByteRange(c.req.header('range'), size);
  if (range === 'invalid') {
    // 416 必须带 Content-Range: bytes */size，播放器据此回到整段重取。
    return new Response(null, {
      status: 416,
      headers: { 'content-range': `bytes */${size}`, 'accept-ranges': 'bytes' },
    });
  }
  const obj = await c.env.R2.get(
    key,
    range ? { range: { offset: range.start, length: range.end - range.start + 1 } } : undefined,
  );
  if (!obj) return c.json({ error: 'not found' }, 404);
  const headers: Record<string, string> = {
    'content-type': head.httpMetadata?.contentType ?? 'application/octet-stream',
    'content-length': String(range ? range.end - range.start + 1 : size),
    'accept-ranges': 'bytes',
    'cache-control': 'private, max-age=31536000, immutable',
  };
  if (etag) headers.etag = etag;
  if (range) headers['content-range'] = `bytes ${range.start}-${range.end}/${size}`;
  return new Response(obj.body, { status: range ? 206 : 200, headers });
});

app.get('/api/app/image', requireApp, async (c) => {
  const key = c.req.query('key') ?? '';
  if (!key.startsWith('images/') || key.length > 200) return c.json({ error: 'not found' }, 404);
  const obj = await getObject(c.env, key);
  if (!obj) return c.json({ error: 'not found' }, 404);
  return new Response(await obj.arrayBuffer(), {
    headers: {
      'content-type': obj.httpMetadata?.contentType ?? 'application/octet-stream',
      'cache-control': 'private, max-age=86400',
    },
  });
});

/** App 读取云端语音配置（多设备一致）。 */
app.get('/api/app/tts-config', requireApp, async (c) => {
  const config = await loadTtsConfig(c.env);
  return c.json({ ok: true, config });
});

/** App 上传语音配置：设置变了就同步一次，网页也用这份。 */
app.post('/api/app/tts-config', requireApp, async (c) => {
  const body = await c.req.json().catch(() => null);
  const config = await saveTtsConfig(c.env, body);
  return c.json({ ok: true, config });
});

/** 网页合成语音：走云端配置 + R2 缓存，声音和 App 一致。 */
app.post('/api/tts/speak', requireAuth, async (c) => {
  const body = (await c.req.json().catch(() => null)) as { text?: unknown; style?: unknown } | null;
  const text = typeof body?.text === 'string' ? body.text.trim().slice(0, 1200) : '';
  if (!text) return c.json({ error: 'text 不能为空' }, 400);
  const style = typeof body?.style === 'string' ? body.style.replace(/[^a-z]/gi, '') : undefined;
  try {
    const { key, audio, cached } = await speakWithCache(c.env, text, { style });
    return new Response(audio, {
      headers: {
        'content-type': 'audio/mpeg',
        'cache-control': 'private, max-age=86400',
        'x-tts-cache': cached ? 'hit' : 'miss',
        // 网页拿到 key 后直接用 /api/audio/<key> 播放，省一次大响应体
        'x-tts-key': key,
      },
    });
  } catch (e) {
    console.error('[tts] speak failed:', e);
    return c.json({ error: 'tts failed' }, 502);
  }
});

/** 网页读取当前语音配置（用于显示，不含密钥）。 */
app.get('/api/tts/config', requireAuth, async (c) => {
  return c.json({ ok: true, config: await loadTtsConfig(c.env) });
});

/**
 * App 状态页：心情 / 关系 / 记忆 / 今天 / 余额。
 * 刻意只回模糊的一句话，不回 0-100 的数值。
 */
app.get('/api/app/status', requireApp, async (c) => {
  const snapshot = await getStatusSnapshot(c.env);
  return c.json(snapshot);
});

/**
 * App TTS 代理：手机直连 eastus 实测 20s+，改走 Worker 边缘节点。
 * 设备 Token 鉴权；只接受短文本，避免变成公开 TTS。
 */
app.post('/api/app/tts', requireApp, async (c) => {
  const body = await c.req.json().catch(() => null) as {
    text?: unknown;
    voice?: unknown;
    rate?: unknown;
    pitch?: unknown;
    style?: unknown;
    style_degree?: unknown;
  } | null;
  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  if (!text || text.length > 2000) return c.json({ error: 'text invalid' }, 400);
  const key = c.env.AZURE_SPEECH_KEY;
  if (!key) return c.json({ error: 'tts not configured' }, 503);
  const region = (c.env.AZURE_SPEECH_REGION || 'eastus').replace(/[^a-z0-9-]/gi, '');
  const voice = typeof body?.voice === 'string' && /^[A-Za-z0-9-]+$/.test(body.voice)
    ? body.voice
    : 'zh-CN-XiaoyiNeural';
  const rate = typeof body?.rate === 'string' ? body.rate.replace(/[^0-9%+-]/g, '') : '+5%';
  const pitch = typeof body?.pitch === 'string' ? body.pitch.replace(/[^0-9%+\-Hz]/g, '') : '+3Hz';
  const style = typeof body?.style === 'string' ? body.style.replace(/[^a-z]/gi, '') : '';
  const degree = typeof body?.style_degree === 'string'
    ? body.style_degree.replace(/[^0-9.]/g, '')
    : '1.2';
  const escape = (s: string) => s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/'/g, '&apos;')
    .replace(/"/g, '&quot;');
  const inner = `<prosody rate='${escape(rate)}' pitch='${escape(pitch)}'>${escape(text)}</prosody>`;
  const content = style
    ? `<mstts:express-as style='${style}' styledegree='${escape(degree)}'>${inner}</mstts:express-as>`
    : inner;
  const ssml = `<speak version='1.0' xml:lang='zh-CN' xmlns:mstts='https://www.w3.org/2001/mstts'><voice xml:lang='zh-CN' name='${escape(voice)}'>${content}</voice></speak>`;
  const upstream = await fetch(
    `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`,
    {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': key,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
        'User-Agent': 'DS-Mobile-Worker',
      },
      body: ssml,
    },
  );
  if (!upstream.ok) {
    const detail = (await upstream.text()).slice(0, 300);
    return c.json({ error: 'tts upstream failed', status: upstream.status, detail }, 502);
  }
  return new Response(await upstream.arrayBuffer(), {
    headers: {
      'content-type': 'audio/mpeg',
      'cache-control': 'no-store',
    },
  });
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

/* ---------- 主动消息队列（反向轮询：客户端拉取） ---------- */

/** Bearer 鉴权（复用 ASTROBOT_API_KEY；管理端/上传/TTS 只认这个）。 */
async function checkQueueAuth(c: Context<AppEnv>): Promise<boolean> {
  const auth = c.req.header('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) return false;
  const expected = c.env.ASTROBOT_API_KEY;
  return Boolean(expected) && token === expected;
}

/** 只给主动消息 pending/ack/nack 使用：允许设备 Token，避免把 API Key 打进 APK。 */
async function checkAppOrQueueAuth(c: Context<AppEnv>): Promise<boolean> {
  if (await checkQueueAuth(c)) return true;
  const auth = c.req.header('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) return false;
  const device = await c.env.KV.get(`app:device:${token}`).catch(() => null);
  return device !== null;
}

/**
 * 今日主动消息计划（App 用）。
 *
 * 客户端拿到 slots 后，在 `at - tolerance_min` 设一个 setAndAllowWhileIdle 闹钟，
 * 醒来拉一次 /api/app/events。不需要 SCHEDULE_EXACT_ALARM——主动消息的时刻本来
 * 就带随机性，晚十几分钟用户感知不到；超过 notify_deadline_min 就不弹通知。
 */
app.get('/api/proactive/plan', requireApp, async (c) => {
  const today = dateKeyInBeijing();
  const raw = (c.req.query('date') ?? today).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return c.json({ error: 'invalid_date' }, 400);

  const target = Date.parse(`${raw}T00:00:00+08:00`);
  if (!Number.isFinite(target)) return c.json({ error: 'invalid_date' }, 400);
  // 只允许 ±7 天：既够补看错过的档，又不至于被当成历史查询接口
  const diffDays = Math.round((target - Date.parse(`${today}T00:00:00+08:00`)) / 86400000);
  if (Math.abs(diffDays) > 7) return c.json({ error: 'date_out_of_range' }, 400);

  const plan = await readPlan(c.env, new Date(), raw);
  // fallback 给客户端兜底：计划拉取失败时至少还有两个固定时段
  return c.json({ ...plan, fallback: fallbackPlanTimes() });
});

/** 拉取待发送的主动消息。 */
app.get('/api/proactive/pending', async (c) => {
  if (!(await checkAppOrQueueAuth(c))) return c.json({ error: 'unauthorized' }, 401);
  const limitRaw = Number(c.req.query('limit') ?? '5');
  const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 5, 1), 20);
  const messages = await takePending(c.env, limit);
  // ★ 不再在拉取时计尝试次数：拉取不代表发送。失败由插件调 /nack 上报，
  //   否则「插件发送失败 / UMO 失效」会静默地把消息在 5 分钟后丢掉。
  return c.json({ messages });
});

/** 上报发送失败（插件调用）：attempts+1，5 次后不再下发。 */
app.post('/api/proactive/nack', async (c) => {
  if (!(await checkAppOrQueueAuth(c))) return c.json({ error: 'unauthorized' }, 401);
  const body = await c.req.json().catch(() => null);
  const ids = body && Array.isArray(body.ids) ? body.ids.filter((x: unknown) => typeof x === 'number') : [];
  await markAttempt(c.env, ids);
  return c.json({ ok: true, failed: ids.length });
});

/** 确认已发送。 */
app.post('/api/proactive/ack', async (c) => {
  if (!(await checkAppOrQueueAuth(c))) return c.json({ error: 'unauthorized' }, 401);
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
  const body = (await c.req.json().catch(() => null)) as { kind?: unknown; force?: unknown } | null;
  const kind = body?.kind === 'morning' ? 'morning' : 'evening';
  return c.json(await runProactiveNow(c.env, new Date(), kind, body?.force === true));
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
  if (now.getUTCMinutes() !== 0) return;
  const hour = now.getUTCHours();
  if (hour !== 0 && hour !== 8 && hour !== 16) return;
  await runContextRefresh(env, now);
}

async function runChannelCheck(env: Env, now: Date): Promise<void> {
  const result = await checkChannelOffline(env, now).catch(() => 'skip' as const);
  if (result === 'alerted') console.warn('[cron] 聊天通道掉线，已生成提醒');
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
        })(),
      );
      logCron(env, ctx, cron, startedAt);
      return;
    }

    if (cron === '* 1-14 * * *') {
      // QQ 通道掉线检查：与主动消息是否暂停无关，每次 tick 都查
      ctx.waitUntil(runChannelCheck(env, now));
      // 白天随机主动消息：打分决策 + 落库 + 推送 QQ（直连或队列）
      ctx.waitUntil(runWebProactiveRandom(env, now));
      // 这条 cron 实际覆盖 UTC 8 点 → 北京 16:00 的 context 刷新
      ctx.waitUntil(maybeRefreshContext(env, now));
      logCron(env, ctx, cron, startedAt);
      return;
    }

    if (cron === '* 23,0,14,15,16 * * *') {
      // QQ 通道掉线检查（同上）
      ctx.waitUntil(runChannelCheck(env, now));
      // 早晚固定主动消息：打分决策 + 落库 + 推送 QQ（直连或队列）
      ctx.waitUntil(runWebProactiveSlot(env, now));
      // 这条 cron 覆盖 UTC 0 / 16 点 → 北京 08:00 / 24:00 的 context 刷新
      ctx.waitUntil(maybeRefreshContext(env, now));
      logCron(env, ctx, cron, startedAt);
      return;
    }

    console.warn('[cron] unknown cron expression:', cron);
    logCron(env, ctx, cron, startedAt, false);
  },
} satisfies ExportedHandler<Env>;
