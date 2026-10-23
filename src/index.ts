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
import { randomHex, verifyPassword } from './auth';
import { streamChat } from './chat';
import { messagesPage, usageByDay } from './db';
import { getMemory, MEMORY_KV_KEY } from './memory';
import { messagesSince } from './db';
import { byteLength } from './memory-maintenance';
import { getCityConfig, setCity } from './settings';
import { fetchWeather } from './weather';
import { saveImage } from './media';
import { deleteObject, getObject, getStorageMode, listKeys, secondaryEnabled } from './storage';
import { runDailyArchive, runContextRefresh, runMonthlyMerge } from './jobs';
import { reindexMemory } from './memory-index';
import { getOrCreateDayContext } from './context';
import { parseRelationValues, reportSectionBudgets } from './memory-maintenance';
import { analyzeMood } from './mood';
import { mergeMood, needsAiVerification, verifyMoodWithAI } from './mood-ai';
import {
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
  simulateEmotion,
} from './emotion-context';
import { applyEventsToVector, extractEmotionEvents, reconcileWithApology, type EmotionEvent } from './emotion-events';
import { buildEmotionSnapshot, describeEmotionState } from './emotion-snapshot';
import { decayEmotion, emptyEmotionVector, type EmotionVector } from './emotion-vector';

type AppEnv = { Bindings: Env };
const app = new Hono<AppEnv>();

const AUTH_KV_PREFIX = 'auth:';
const AUTH_TTL_SECONDS = 7 * 24 * 60 * 60;

/** QQ 客户端心跳（存在 KV，用于判断通道是否还活着）。 */
const HEARTBEAT_KV_KEY = 'proactive:heartbeat';
const HEARTBEAT_TTL_SECONDS = 7 * 24 * 60 * 60;
/** 超过这么久没心跳就算离线（客户端 5 分钟一次）。 */
const HEARTBEAT_ONLINE_SECONDS = 15 * 60;

/** 登录校验：Cookie 中的 token 必须在 KV 中存在。 */
async function requireAuth(c: Context<AppEnv>, next: Next) {
  const token = getCookie(c, 'ds_token');
  const ok = token ? (await c.env.KV.get(`${AUTH_KV_PREFIX}${token}`)) === '1' : false;
  if (!ok) return c.json({ error: '未登录或会话已过期' }, 401);
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

  const token = randomHex(32);
  await c.env.KV.put(`${AUTH_KV_PREFIX}${token}`, '1', { expirationTtl: AUTH_TTL_SECONDS });
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
  const token = getCookie(c, 'ds_token');
  if (token) await c.env.KV.delete(`${AUTH_KV_PREFIX}${token}`).catch(() => {});
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
  return streamChat(c.env, content, now, image, channel);
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
/** 危险操作：清空 D1 全部业务表 + R2 全部对象（主/小号）+ 记忆相关 KV，仅测试期使用。 */
app.post('/api/admin/wipe-data', requireAuth, async (c) => {
  const tables = ['messages', 'proactive_feedback', 'proactive_log', 'proactive_queue', 'cron_runs', 'memory_entries'];
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
    MEMORY_KV_KEY, 'archive:cache', 'memo:24h', 'memo:lock',
    'profile:user', 'profile:dirty', 'proactive:heartbeat',
    'summary:2026-10-23', 'summary:2026-10-24',
    'mood:usage:2026-10-23', 'mood:usage:2026-10-24',
    'memory:index',
  ];
  for (const k of kvKeys) await c.env.KV.delete(k).catch(() => {});
  return c.json({ ok: true, d1, r2_deleted: r2, kv_cleared: kvKeys.length });
});
app.post('/api/admin/run-daily', requireAuth, async (c) => {
  const result = await runDailyArchive(c.env, new Date());
  return c.json({ ok: true, ...result });
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
  });
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

app.get('/api/admin/stats', requireAuth, async (c) => {
  const [countRow, oldestRow, runs, logKeys] = await Promise.all([
    c.env.DB.prepare('SELECT COUNT(*) AS c FROM messages').first<{ c: number }>(),
    c.env.DB.prepare('SELECT MIN(date_key) AS d FROM messages').first<{ d: string | null }>(),
    c.env.DB
      .prepare('SELECT job_type, target, status, detail, run_at FROM cron_runs ORDER BY id DESC LIMIT 10')
      .all(),
    listKeys(c.env, 'chat_logs/'),
  ]);
  const memory = await getMemory(c.env);
  // 分层记忆的可观测性：核心层占用、超预算分区、中期纪要条数、档案条数
  const [memo, archiveLines] = await Promise.all([getRecentMemo(c.env), getArchiveLines(c.env)]);
  return c.json({
    messages: countRow?.c ?? 0,
    oldest_date: oldestRow?.d ?? null,
    memory_bytes: byteLength(memory),
    core_target_bytes: CORE_TARGET_BYTES,
    over_budget_sections: reportSectionBudgets(memory)
      .filter((b) => b.over)
      .map((b) => ({ header: b.header, bytes: b.bytes, budget: b.budget })),
    recent_memo_items: memo ? memo.text.split('\n').filter((l) => l.trim().startsWith('- ')).length : 0,
    archive_lines: archiveLines.length,
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
  const hb = (await c.env.KV.get(HEARTBEAT_KV_KEY, 'json').catch(() => null)) as {
    at?: string;
    connected?: boolean;
    queue_depth?: number | null;
    version?: string | null;
    last_error?: string | null;
  } | null;
  const ageSeconds = hb?.at ? (Date.now() - Date.parse(hb.at)) / 1000 : null;
  return c.json({
    ...stats,
    // ★ QQ 通道可见性：手机杀后台后客户端会静默消失，只能靠心跳判断
    heartbeat: hb,
    heartbeat_age_seconds: ageSeconds,
    paused_until: await c.env.KV.get('proactive:paused_until').catch(() => null),
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
    await c.env.KV.delete('proactive:paused_until').catch(() => {});
    return c.json({ ok: true, paused_until: null });
  }
  const until = new Date(Date.now() + days * 86400000).toISOString();
  await c.env.KV.put('proactive:paused_until', until, {
    expirationTtl: days * 86400 + 3600,
  });
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
  await c.env.KV.put(HEARTBEAT_KV_KEY, JSON.stringify(payload), {
    expirationTtl: HEARTBEAT_TTL_SECONDS,
  });
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
      // 白天随机主动消息：打分决策 + 落库 + 推送 QQ（直连或队列）
      ctx.waitUntil(runWebProactiveRandom(env, now));
      // 这条 cron 实际覆盖 UTC 8 点 → 北京 16:00 的 context 刷新
      ctx.waitUntil(maybeRefreshContext(env, now));
      return;
    }

    if (cron === '*/5 23,0,14,15,16 * * *') {
      // 早晚固定主动消息：打分决策 + 落库 + 推送 QQ（直连或队列）
      ctx.waitUntil(runWebProactiveSlot(env, now));
      // 这条 cron 覆盖 UTC 0 / 16 点 → 北京 08:00 / 24:00 的 context 刷新
      ctx.waitUntil(maybeRefreshContext(env, now));
      return;
    }

    console.warn('[cron] unknown cron expression:', cron);
  },
} satisfies ExportedHandler<Env>;
