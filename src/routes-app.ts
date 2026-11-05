/**
 * App（Android 客户端）专用接口：配对、心跳、增量消息、双向对账、记忆纠正。
 *
 * 从 index.ts 拆出来：这一组接口都认设备 Token（requireApp），跟网页端的
 * Cookie 鉴权是两条独立的信任链，放一起才不会混。
 */
import type { Hono } from 'hono';
import type { Env } from './types';
import { randomHex } from './auth';
import { requireApp, requireAuth } from './middleware';
import { messagesPage, messagesSince, type MessageRow } from './db';
import { isoInBeijing } from './date';
import { archivedMessagesBefore } from './archive';
import { resolveDiaryConsent } from './life/diary-job';
import { flushHeldMessages } from './life/flush';
import { applyMemoryCorrection } from './memory-correction';
import { parseRelationValues } from './memory-maintenance';
import { stripAttachmentWrapper } from './openai';
import { putRuntimeState } from './runtime-store';
import { getObject } from './storage';
import { lifeNow } from './life/jobs';
import { RECIPES } from './life/recipes';
import { askDiary, diaryList, diaryOne } from './life/diary-api';
import { nearestCity } from './life/weather';
import { beijingDateKey } from './life/state';
import { formatBiliMeta, type BiliMeta } from './bili';
import { ASR_MAX_BYTES, transcribe } from './media/asr';
import { signMediaPath } from './media/signed-url';
import { lookAtVideo } from './media/video-vision';
import { biliVisionDirect } from './media/bili-vision';

type AppEnv = { Bindings: Env; Variables: { requestId: string } };

const HEARTBEAT_KV_KEY = 'proactive:heartbeat';
const HEARTBEAT_TTL_SECONDS = 7 * 24 * 60 * 60;

/** 历史消息读取时兜底清洗平台包装（AstrBot 文件附件等），顺带兼容修复前落库的旧数据。 */
export function sanitizeStoredMessages<T extends { content: string }>(rows: T[]): T[] {
  return rows.map((m) => ({ ...m, content: stripAttachmentWrapper(m.content) }));
}

/**
 * 配对码限流：不限制的话配对码可以无限暴力试（8 位字母数字几小时就能穷举）。
 * 固定窗口计数，超上限直接 429，正常用户不会撞上。
 */
const PAIR_LIMIT_MAX = 8;
const PAIR_LIMIT_WINDOW_SEC = 10 * 60;

/** 纯判定：给定这一格的计数，该不该拦。 */
export function rateLimitVerdict(
  count: number,
  now = Date.now(),
): { blocked: boolean; retryAfter: number } {
  const retryAfter = PAIR_LIMIT_WINDOW_SEC - Math.floor((now % (PAIR_LIMIT_WINDOW_SEC * 1000)) / 1000);
  return { blocked: count > PAIR_LIMIT_MAX, retryAfter };
}

/**
 * 配对码限流：不限制的话配对码可以无限暴力试（8 位字母数字几小时就能穷举）。
 *
 * ★ 用 D1 而不是 KV：KV 是最终一致的，连着打十次可能每次都读到旧计数，
 *   限流形同虚设（实测过，10 次全放行）。D1 的 upsert 是原子的，才拦得住。
 */
export async function pairRateLimit(
  env: Env,
  ip: string,
  now = Date.now(),
): Promise<{ blocked: boolean; retryAfter: number }> {
  const windowStart = Math.floor(now / (PAIR_LIMIT_WINDOW_SEC * 1000));
  const row = await env.DB.prepare(
    `INSERT INTO pair_limits (ip, window_start, count) VALUES (?, ?, 1)
     ON CONFLICT(ip) DO UPDATE SET
       count = CASE WHEN window_start = excluded.window_start THEN count + 1 ELSE 1 END,
       window_start = excluded.window_start
     RETURNING count`,
  )
    .bind(ip, windowStart)
    .first<{ count: number }>()
    .catch(() => null);
  return rateLimitVerdict(row?.count ?? 0, now);
}

export function registerAppRoutes(app: Hono<AppEnv>): void {

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
  /**
 * 日记列表：只给日期和能不能看，不泄正文（§10.4）。
 */
app.get('/api/app/ai-diary/index', requireApp, async (c) => {
  const items = await diaryList(c.env, Number(c.req.query('limit') ?? 60));
  return c.json({ ok: true, items });
});

/**
 * 看某一天的日记。
 *
 * 没同意就只给日期/天气/身体这些基本信息，正文**不出服务端**；
 * 同意只算当天，过期要重新问（见 diary-api.ts）。
 */
app.get('/api/app/ai-diary', requireApp, async (c) => {
  const date = c.req.query('date') ?? beijingDateKey();
  // 有 pending 的就把聊天记录交给模型判一次（放这里而不是聊天请求里）
  await resolveDiaryConsent(c.env).catch(() => {});
  const { row, text, shareReason, peeked } = await diaryOne(c.env, date);
  if (!row) return c.json({ ok: true, date, visible: false, reason: '这天没写' });
  if (!row.visible && !row.peek) {
    return c.json({
      ok: true,
      date: row.date,
      visible: false,
      asked: row.asked,
      expired: row.expired,
      declined: row.declined,
      cooling: row.cooling,
      retryAt: row.retryAt,
      basics: { weekday: row.weekday, weather: row.weather, tempC: row.tempC, location: row.location },
      reason: row.declined
      ? row.cooling
        ? '她刚说过不给，过会儿再问'
        : '她说不给'
      : row.expired
        ? '那天给你看过，过了那天要再问她一次'
        : row.asked
          ? '问过了，她还没答'
          : '这篇她还没说要不要给你看',
    });
  }
  return c.json({
    ok: true,
    date: row.date,
    visible: true,
    peeked: Boolean(peeked),
    text,
    shareReason,
    images: row.images,
    basics: { weekday: row.weekday, weather: row.weather, tempC: row.tempC, location: row.location },
  });
});

/** 「问问她」：标成 pending，等聊天里她回话。 */
app.post('/api/app/ai-diary/ask', requireApp, async (c) => {
  const body = (await c.req.json().catch(() => null)) as { date?: string } | null;
  if (!body?.date) return c.json({ ok: false, error: '需要 date' }, 400);
  const result = await askDiary(c.env, body.date);
  if (!result.ok) return c.json(result, 404);
  return c.json({ ...result, hint: result.already ? undefined : '去聊天里问她吧，她答了才算' });
});

/**
 * 她现在的状态。
 *
 * 注意 start/end 给的是「19:03」这种字符串（跨午夜带 +1），以前直接回分钟数，
 * App 那边原样显示成「1148 打算做饭」——数字看着像乱码。
 * 分钟数另给一份 start_min/end_min，需要算时间的客户端用那个。
 */
function clockText(minute: number): string {
  const over = minute >= 1440;
  const m = minute % 1440;
  const hh = String(Math.floor(m / 60)).padStart(2, '0');
  const mm = String(m % 60).padStart(2, '0');
  return over ? `${hh}:${mm}+1` : `${hh}:${mm}`;
}

/** 日记配图（手机端，走 app token）。只放行 diary-images/ 前缀。 */
app.get('/api/app/diary-image/*', requireApp, async (c) => {
  const key = decodeURIComponent(c.req.path.replace(/^\/api\/app\/diary-image\//, ''));
  if (!key.startsWith('diary-images/')) return c.json({ error: 'not found' }, 404);
  const obj = await getObject(c.env, key);
  if (!obj) return c.json({ error: 'not found' }, 404);
  return new Response(await obj.arrayBuffer(), {
    headers: {
      'content-type': obj.httpMetadata?.contentType ?? 'image/jpeg',
      'cache-control': 'private, max-age=604800',
    },
  });
});

/**
 * B 站链接回填：网页端发的链接 Worker 出口拿不到 meta（B 站对机房 IP 直接 412），
 * 手机能直连。App 同步历史时看到"有链接没资料"的用户消息，就在本地解析，
 * 再把结果按 message_id 回填到 D1——网页上那张卡片随后变完整。
 */
app.post('/api/app/bili-meta', requireApp, async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    message_id?: unknown;
    url?: unknown;
    title?: unknown;
    owner?: unknown;
    duration?: unknown;
    cover?: unknown;
    desc?: unknown;
  } | null;
  const messageId = Number(body?.message_id);
  const url = typeof body?.url === 'string' ? body.url.trim() : '';
  const title = typeof body?.title === 'string' ? body.title.trim() : '';
  if (!Number.isFinite(messageId) || messageId <= 0 || !url || !title) {
    return c.json({ error: 'message_id/url/title 必填' }, 400);
  }

  const row = await c.env.DB.prepare('SELECT id, role, content FROM messages WHERE id = ?')
    .bind(messageId)
    .first<{ id: number; role: string; content: string }>();
  if (!row) return c.json({ error: 'not found' }, 404);
  if (row.role !== 'user') return c.json({ error: '只能回填用户消息' }, 400);

  const meta: BiliMeta = {
    bvid: '',
    title,
    owner: typeof body?.owner === 'string' ? body.owner : '',
    duration: Number(body?.duration) || 0,
    cover: typeof body?.cover === 'string' ? body.cover : '',
    desc: typeof body?.desc === 'string' ? body.desc : '',
  } as BiliMeta;
  const block = formatBiliMeta(meta, url);
  // 已经有资料就原地替换（别越堆越长），没有就接在原文后面
  const content = /\[BILI_META\][\s\S]*?\[\/BILI_META\]/.test(row.content)
    ? row.content.replace(/\[BILI_META\][\s\S]*?\[\/BILI_META\]/, block)
    : `${row.content}\n\n${block}`;
  if (content === row.content) return c.json({ ok: true, unchanged: true });

  await c.env.DB.prepare('UPDATE messages SET content = ? WHERE id = ?').bind(content, row.id).run();
  return c.json({ ok: true, message_id: row.id, chars: content.length });
});

/** 删除墓碑：App 每次同步拉一遍，把本地缓存里已删的消息清掉。幂等。 */
app.get('/api/app/tombstones', requireApp, async (c) => {
  const rows = await c.env.DB.prepare(
    'SELECT id FROM message_tombstones ORDER BY id DESC LIMIT 500',
  )
    .all<{ id: number }>()
    .catch(() => null);
  return c.json({ ok: true, ids: (rows?.results ?? []).map((x) => x.id) });
});

/** 设备吊销：手机丢了就把它踢掉，删掉这个 token 之后所有接口 401。 */
app.post('/api/app/unpair', requireApp, async (c) => {
  const auth = c.req.header('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) return c.json({ error: 'invalid_token' }, 401);
  await c.env.KV.delete(`app:device:${token}`).catch(() => {});
  return c.json({ ok: true, revoked: true });
});

app.get('/api/app/ai-status', requireApp, async (c) => {
  const status = await lifeNow(c.env);
  return c.json({
    ok: true,
    date: status.dateKey,
    // 状态名两个都带：老客户端读 state，新客户端读 status
    state: status.status,
    status: status.status,
    // 今天是什么日子（大扫除日/通宵追番日/生病日…）；普通日子为 null
    day_type: status.recipe ? { id: status.recipe, label: RECIPES[status.recipe as keyof typeof RECIPES]?.label ?? status.recipe } : null,
    health: status.health,
    current: status.current
      ? {
          title: status.current.title,
          kind: status.current.kind,
          start: clockText(status.current.start_min),
          end: clockText(status.current.end_min),
          start_min: status.current.start_min,
          end_min: status.current.end_min,
          interruptible: status.current.interruptible === 1,
        }
      : null,
    next: status.next
      ? {
          title: status.next.title,
          kind: status.next.kind,
          start: clockText(status.next.start_min),
          start_min: status.next.start_min,
        }
      : null,
  });
});

app.post('/api/app/pair', async (c) => {
    const body = await c.req.json().catch(() => null) as {
      pair_code?: unknown;
      device_name?: unknown;
      device_id?: unknown;
    } | null;
    const pairCode = body && typeof body.pair_code === 'string' ? body.pair_code : '';
    const expected = await loadPairCode(c.env);
    if (!expected) return c.json({ error: 'pair_not_configured' }, 503);

    // 先限流再比对：不然每次尝试都白送一次机会
    const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
    const limit = await pairRateLimit(c.env, ip);
    if (limit.blocked) {
      return c.json({ error: 'too_many_attempts', retry_after: limit.retryAfter }, 429);
    }
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
      // 定位说的是「他在哪」：反推最近城市写进 user-city，她的城市不动
      const city = nearestCity(lat, lng);
      await c.env.KV.put('life:user-city', city).catch(() => {});
      return c.json({ ...result, user_city: city });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  /** App 增量消息：所有渠道，按 id 升序；客户端自己按 id 去重。 */
  /**
   * 到点拉取：客户端按 until 挂闹钟，醒来调这个接口，把压着的消息现场生成出来。
   * 不做全文轮询——生成完再走 /api/app/events 拉增量即可。
   */
  app.post('/api/app/flush', requireApp, async (c) => {
    const result = await flushHeldMessages(c.env, new Date()).catch((e) => ({ flushed: 0, skipped: 'error:' + String(e) }));
    return c.json({ ok: true, ...result, at: new Date().toISOString() });
  });

  /**
   * 视频台词：手机抽出的音轨直接传过来，服务端转成带时间戳的台词。
   *
   * 只传音轨（一分钟约 1 MB），不传视频——隐私面小，也省得上传原始视频。
   * 结果按音频内容缓存，同一个视频再发一次不会重复识别。
   */
  app.post('/api/app/video-asr', requireApp, async (c) => {
    const declared = Number(c.req.header('content-length') ?? 0);
    if (declared > ASR_MAX_BYTES) {
      return c.json({ ok: false, error: '音频太大（上限 25 MB）' }, 413);
    }
    let audio: ArrayBuffer;
    try {
      audio = await c.req.arrayBuffer();
    } catch (e) {
      return c.json({ ok: false, error: '读不到音频：' + String(e) }, 400);
    }
    if (audio.byteLength < 512) return c.json({ ok: false, error: '音频为空' }, 400);
    try {
      const { lines, cached } = await transcribe(c.env, audio);
      return c.json({ ok: true, lines, cached, bytes: audio.byteLength });
    } catch (e) {
      return c.json({ ok: false, error: '识别失败：' + String(e) }, 502);
    }
  });

  /**
   * 视频理解：手机传完视频后调这里，拿回「带时间点的观察笔记」。
   *
   * 视频本体留在 R2，只把 10 分钟有效的签名 URL 交给千问 omni，
   * 由它看完写出文字；DeepSeek 拿到的是这段文字，不是视频。
   */
  app.post('/api/app/video-vision', requireApp, async (c) => {
    const body = (await c.req.json().catch(() => null)) as { key?: string } | null;
    const key = (body?.key ?? '').trim();
    if (!/^videos\/[0-9A-Za-z/_.-]+\.(mp4|mov|m4v|webm|3gp)$/.test(key)) {
      return c.json({ ok: false, error: '视频 key 不合法' }, 400);
    }
    if (!c.env.DASHSCOPE_API_KEY) {
      return c.json({ ok: false, error: '未配置视频理解模型' }, 503);
    }
    const secret = c.env.AUTH_SECRET;
    if (!secret) return c.json({ ok: false, error: '未配置签名密钥' }, 503);
    const origin = new URL(c.req.url).origin;
    const path = await signMediaPath(secret, key);
    try {
      const obs = await lookAtVideo(c.env, origin + path, { cacheKey: key });
      return c.json({ ok: true, text: obs.text, ms: obs.ms, cached: obs.cached, model: obs.model });
    } catch (e) {
      return c.json({ ok: false, error: String(e).slice(0, 200) }, 502);
    }
  });

  /**
   * B 站视频理解：拿 playurl 直链交给千问 omni，返回按时间点的画面笔记。
   * 失败返回 ok:false，App 继续用原来的大纲 + 字幕 + 雪碧图。
   */
  app.post('/api/app/bili-vision', requireApp, async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | { direct?: string; title?: string; duration?: number; cacheKey?: string }
      | null;
    // 机房 IP 拉 B 站接口会被 412，所以直链由手机端取好传上来，服务端只负责交给模型。
    const direct = (body?.direct ?? '').trim();
    if (!/^https:\/\/[^\s]+$/.test(direct) || direct.length > 2000) {
      return c.json({ ok: false, error: '缺少可用的直链' }, 400);
    }
    try {
      const v = await biliVisionDirect(c.env, {
        direct,
        title: (body?.title ?? '').slice(0, 120),
        duration: Number(body?.duration ?? 0) || 0,
        cacheKey: (body?.cacheKey ?? '').slice(0, 120),
      });
      if (!v) return c.json({ ok: false, error: '拿不到直链或模型失败' }, 502);
      // 留一份直链：他之后说「再看一眼」时，服务端要靠它重看（直链约两小时有效）
      await c.env.KV.put(
        'bili:last',
        JSON.stringify({
          direct,
          title: v.title,
          duration: v.duration,
          cacheKey: body?.cacheKey ?? '',
          at: Date.now(),
        }),
        { expirationTtl: 6 * 3600 },
      ).catch(() => {});
      return c.json({ ok: true, title: v.title, duration: v.duration, text: v.text, ms: v.ms, cached: v.cached });
    } catch (e) {
      return c.json({ ok: false, error: String(e).slice(0, 200) }, 502);
    }
  });

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
      // 回复挂在哪条上：App 靠它把补发的回复排回原位（不然会跑到列表末尾）
      reply_to_id: m.reply_to_id,
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
      // 回复挂在哪条上：App 靠它把补发的回复排回原位（不然会跑到列表末尾）
      reply_to_id: m.reply_to_id,
      proactive_kind: m.proactive_kind,
      client_message_id: m.client_message_id,
    }));
    return c.json({ messages: sanitizeStoredMessages(payload) });
  });
}
