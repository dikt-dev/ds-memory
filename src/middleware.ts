/**
 * 鉴权中间件（原来定义在 index.ts，路由拆分后共享）。
 *
 * - requireAuth：后台登录态（签名 Cookie，kv 模式是回滚路径）
 * - requireApp：DS-Mobile 设备 Token，只放行 App 自己的消息事件接口
 */
import type { Context, Next } from 'hono';
import { getCookie } from 'hono/cookie';
import type { AppEnv } from './types';
import { authMode, authSecret, isAuthTokenRevoked, verifyAuthToken } from './auth';

const AUTH_KV_PREFIX = 'auth:';

/** 登录校验：signed 优先（无 KV 读）；kv 模式保留为回滚路径。 */
export async function requireAuth(c: Context<AppEnv>, next: Next) {
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

/** DS-Mobile 设备 Token 鉴权：只允许访问 App 自己的消息事件接口。 */
export async function requireApp(c: Context<AppEnv>, next: Next) {
  const auth = c.req.header('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) return c.json({ error: 'invalid_token' }, 401);
  const device = await c.env.KV.get(`app:device:${token}`).catch(() => null);
  if (!device) return c.json({ error: 'invalid_token' }, 401);
  await next();
}

/**
 * 当前生效的配对码：网页上设的（KV `pair:code`）> 环境变量 APP_PAIR_CODE > ASTROBOT_API_KEY。
 * 这样不用重新部署就能改码，也就不用把一个长期 API Key 当配对码用。
 */
