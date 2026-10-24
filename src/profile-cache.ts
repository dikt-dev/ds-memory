/**
 * 用户画像持久化（KV 缓存）。
 *
 * 问题：每次 cron tick 都要扫描 14 天消息统计活跃时段，浪费 D1 读配额。
 * 方案：画像缓存 6 小时；有新消息时标记脏，下次读取时重算。
 */
import type { Env } from './types';
import type { UserProfile } from './proactive-engine';

export const PROFILE_KV_KEY = 'profile:user';
export const PROFILE_DIRTY_KEY = 'profile:dirty';
export const PROFILE_TTL_SECONDS = 6 * 60 * 60;

export interface CachedProfile extends UserProfile {
  computed_at: string;
  /** 画像基于多少条消息统计 */
  sample_size: number;
}

/** 标记画像需要重算（有新消息时调用）。
 *
 * ★ 节流：脏标记只是一个布尔量（TTL 24h），每条消息都重写没意义。
 *   同一个 isolate 内 60 秒内只写一次；写入失败仍然节流，最多多算一次画像。
 */
let lastDirtyAt = 0;
const DIRTY_THROTTLE_MS = 60 * 1000;

export async function markProfileDirty(env: Env): Promise<void> {
  const now = Date.now();
  if (now - lastDirtyAt < DIRTY_THROTTLE_MS) return;
  lastDirtyAt = now;
  await env.KV.put(PROFILE_DIRTY_KEY, '1', { expirationTtl: 24 * 60 * 60 }).catch(() => {});
}

/** 读取缓存的画像（不存在或已脏则返回 null）。 */
export async function getCachedProfile(env: Env): Promise<CachedProfile | null> {
  try {
    const dirty = await env.KV.get(PROFILE_DIRTY_KEY);
    if (dirty) return null;
    const raw = await env.KV.get(PROFILE_KV_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedProfile;
    if (!Array.isArray(parsed.hourlyActivity) || parsed.hourlyActivity.length !== 24) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** 写入画像缓存并清除脏标记。 */
export async function setCachedProfile(env: Env, profile: UserProfile): Promise<void> {
  const cached: CachedProfile = {
    ...profile,
    computed_at: new Date().toISOString(),
    sample_size: profile.totalMessages,
  };
  await env.KV.put(PROFILE_KV_KEY, JSON.stringify(cached), { expirationTtl: PROFILE_TTL_SECONDS }).catch(() => {});
  await env.KV.delete(PROFILE_DIRTY_KEY).catch(() => {});
}

// ── QQ 通道心跳（客户端每 5 分钟上报一次） ─────────────────────────
export interface HeartbeatRecord {
  at: string;
  connected: boolean;
  queue_depth: number | null;
  version: string | null;
  last_error: string | null;
}

/** 读心跳记录（没有或格式不对返回 null）。 */
export async function getHeartbeat(env: Env): Promise<HeartbeatRecord | null> {
  const raw = (await env.KV.get('proactive:heartbeat', 'json').catch(() => null)) as
    | HeartbeatRecord
    | null;
  if (!raw || typeof raw.at !== 'string') return null;
  return raw;
}

/** 读「上次已经提醒过的掉线心跳时间」。 */
export async function getOfflineAlertedAt(env: Env): Promise<string | null> {
  return env.KV.get('proactive:offline_alert').catch(() => null);
}

/** 记下已提醒（同一个掉线事件只提醒一次）。 */
export async function setOfflineAlertedAt(env: Env, at: string): Promise<void> {
  await env.KV.put('proactive:offline_alert', at, { expirationTtl: 7 * 86400 }).catch(() => {});
}
