/**
 * 队列/设备鉴权：管理端与插件用 Bearer API Key，App 用设备 Token。
 *
 * 拆出来是因为 index.ts 的上传/TTS 路由和 routes-proactive.ts 都要用同一套判定，
 * 而"设备 Token 也算通过"这条规则只该写一次。
 */
import type { Context } from 'hono';
import type { Env } from './types';

type AppEnv = { Bindings: Env; Variables: { requestId: string } };

/** Bearer 鉴权（复用 ASTROBOT_API_KEY；管理端/上传/TTS 只认这个）。 */
export async function checkQueueAuth(c: Context<AppEnv>): Promise<boolean> {
  const auth = c.req.header('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) return false;
  const expected = c.env.ASTROBOT_API_KEY;
  return Boolean(expected) && token === expected;
}

/** 只给主动消息 pending/ack/nack 使用：允许设备 Token，避免把 API Key 打进 APK。 */
export async function checkAppOrQueueAuth(c: Context<AppEnv>): Promise<boolean> {
  if (await checkQueueAuth(c)) return true;
  const auth = c.req.header('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) return false;
  const device = await c.env.KV.get(`app:device:${token}`).catch(() => null);
  return device !== null;
}
