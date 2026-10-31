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
import { applyMemoryCorrection } from './memory-correction';
import { parseRelationValues } from './memory-maintenance';
import { stripAttachmentWrapper } from './openai';
import { putRuntimeState } from './runtime-store';

type AppEnv = { Bindings: Env; Variables: { requestId: string } };

const HEARTBEAT_KV_KEY = 'proactive:heartbeat';
const HEARTBEAT_TTL_SECONDS = 7 * 24 * 60 * 60;

/** 历史消息读取时兜底清洗平台包装（AstrBot 文件附件等），顺带兼容修复前落库的旧数据。 */
export function sanitizeStoredMessages<T extends { content: string }>(rows: T[]): T[] {
  return rows.map((m) => ({ ...m, content: stripAttachmentWrapper(m.content) }));
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
}
