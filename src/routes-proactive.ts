/**
 * 主动消息队列（反向轮询：客户端拉取）+ 队列鉴权。
 *
 * 从 index.ts 拆出来：这块是「客户端拉取 → 插件发送 → ack/nack 上报」的一条完整链路，
 * 与聊天/记忆/静态资源无关，放一起看才看得懂。
 */
import type { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from './types';
import { dateKeyInBeijing } from './date';
import { requireApp, requireAuth } from './middleware';
import { ackSent, dropMessages, markAttempt, queueStats, takePending } from './queue';
import { fallbackPlanTimes, readPlan } from './proactive-plan';
import { getHeartbeat } from './profile-cache';
import { getRuntimeState, putRuntimeState } from './runtime-store';
import { diagnoseProactive, runProactiveNow, runWebProactiveRandom, runWebProactiveSlot } from './webproactive';
import { checkAppOrQueueAuth, checkQueueAuth } from './queue-auth';
import { deleteRuntimeState } from './runtime-store';

type AppEnv = { Bindings: Env; Variables: { requestId: string } };

/** QQ 客户端心跳（D1 runtime_state，用于判断通道是否还活着）。 */
const HEARTBEAT_KV_KEY = 'proactive:heartbeat';
const HEARTBEAT_TTL_SECONDS = 7 * 24 * 60 * 60;
/** 超过这么久没心跳就算离线（客户端 5 分钟一次）。 */
const HEARTBEAT_ONLINE_SECONDS = 15 * 60;

export function registerProactiveRoutes(app: Hono<AppEnv>): void {
  /* ---------- 主动消息队列（反向轮询：客户端拉取） ---------- */

  
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
}
