/**
 * 口令鉴权 + 无状态签名 token（Phase 1）。
 *
 * - 口令存储：`salt:hash`（与 scripts/hash-password.mjs 一致）；
 * - 登录态：HMAC-SHA256 签名的 Cookie，默认 24h；
 * - “全部登出”：D1 `auth_revocations` 的 global 行；D1 不可用时回退 KV。
 *
 * 单用户硬性约束：只校验口令，不区分用户，永不支持注册。
 */
import type { Env } from './types';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** 无状态 token 的有效期：24 小时。 */
export const AUTH_TOKEN_TTL_SECONDS = 24 * 60 * 60;

export function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** 生成口令哈希（可传固定盐便于复现/测试）。 */
export async function hashPassword(password: string, saltHex?: string): Promise<string> {
  const salt = saltHex ?? randomHex(16);
  const hash = await sha256Hex(`${salt}:${password}`);
  return `${salt}:${hash}`;
}

/** 校验口令（长度相同的常量时间比较）。 */
/* ---------- 无状态 token ---------- */

export interface AuthTokenPayload {
  v: 1;
  iat: number;
  exp: number;
  jti: string;
}

function b64urlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(text: string): Uint8Array {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const keyCache = new Map<string, Promise<CryptoKey>>();

function hmacKey(secret: string): Promise<CryptoKey> {
  const cached = keyCache.get(secret);
  if (cached) return cached;
  const key = crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
  keyCache.set(secret, key);
  return key;
}

/** 签发 24h 无状态 token。 */
export async function signAuthToken(
  secret: string,
  nowMs = Date.now(),
): Promise<{ token: string; payload: AuthTokenPayload }> {
  const iat = Math.floor(nowMs / 1000);
  const payload: AuthTokenPayload = {
    v: 1,
    iat,
    exp: iat + AUTH_TOKEN_TTL_SECONDS,
    jti: randomHex(16),
  };
  const body = b64urlEncode(encoder.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(body));
  return { token: `${body}.${b64urlEncode(new Uint8Array(sig))}`, payload };
}

/** 校验签名、版本、过期时间；失败返回 null。 */
export async function verifyAuthToken(
  token: string,
  secret: string,
  nowMs = Date.now(),
): Promise<AuthTokenPayload | null> {
  if (!token || !secret) return null;
  const dot = token.indexOf('.');
  if (dot <= 0 || dot >= token.length - 1) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  try {
    const ok = await crypto.subtle.verify(
      'HMAC',
      await hmacKey(secret),
      b64urlDecode(sig),
      encoder.encode(body),
    );
    if (!ok) return null;
    const parsed = JSON.parse(decoder.decode(b64urlDecode(body))) as Partial<AuthTokenPayload>;
    const iat = parsed.iat;
    const exp = parsed.exp;
    if (parsed.v !== 1 || typeof iat !== 'number' || typeof exp !== 'number') return null;
    if (!Number.isFinite(iat) || !Number.isFinite(exp)) return null;
    const now = Math.floor(nowMs / 1000);
    if (exp <= now) return null;
    if (iat > now + 60) return null; // 容忍 60 秒时钟偏差
    if (typeof parsed.jti !== 'string' || !parsed.jti) return null;
    return { v: 1, iat, exp, jti: parsed.jti };
  } catch {
    return null;
  }
}

/* ---------- 全局吊销（全部登出） ---------- */

const REVOCATION_CACHE_MS = 10_000;
let revocationCache: { at: number; revokedAt: number } | null = null;

/** 读取全局吊销时间（毫秒）；D1 不可用时回退 KV。 */
export async function getGlobalRevokedAt(env: Env): Promise<number> {
  if (revocationCache && Date.now() - revocationCache.at < REVOCATION_CACHE_MS) {
    return revocationCache.revokedAt;
  }
  let revokedAt = 0;
  try {
    const row = await env.DB.prepare(
      "SELECT revoked_at FROM auth_revocations WHERE scope = 'global'",
    ).first<{ revoked_at: number }>();
    revokedAt = Number(row?.revoked_at) || 0;
  } catch {
    const raw = await env.KV.get('auth:revoked_before').catch(() => null);
    revokedAt = Number(raw) || 0;
  }
  revocationCache = { at: Date.now(), revokedAt };
  return revokedAt;
}

/** 全部登出：写入全局吊销时间。 */
export async function revokeAllAuth(env: Env, nowMs = Date.now()): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO auth_revocations (scope, revoked_at) VALUES ('global', ?)
       ON CONFLICT(scope) DO UPDATE SET revoked_at = excluded.revoked_at`,
    )
      .bind(nowMs)
      .run();
  } catch {
    await env.KV.put('auth:revoked_before', String(nowMs)).catch(() => {});
  }
  revocationCache = { at: Date.now(), revokedAt: nowMs };
}

/** token 是否早于全局吊销时间。 */
export async function isAuthTokenRevoked(env: Env, payload: AuthTokenPayload): Promise<boolean> {
  const revokedAt = await getGlobalRevokedAt(env);
  return revokedAt > 0 && payload.iat * 1000 <= revokedAt;
}

/** 测试/手动重置吊销缓存。 */
export function resetAuthRevocationCache(): void {
  revocationCache = null;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const candidate = await sha256Hex(`${salt}:${password}`);
  if (candidate.length !== hash.length) return false;
  let diff = 0;
  for (let i = 0; i < candidate.length; i++) {
    diff |= candidate.charCodeAt(i) ^ hash.charCodeAt(i);
  }
  return diff === 0;
}

/** 签名密钥：AUTH_SECRET 优先，回滚路径用 ACCESS_PASSWORD_HASH 当密钥。 */
export function authSecret(env: { AUTH_SECRET?: string; ACCESS_PASSWORD_HASH?: string }): string | null {
  return env.AUTH_SECRET?.trim() || env.ACCESS_PASSWORD_HASH?.trim() || null;
}

/** 登录态模式：signed（默认，无 KV 读）/ kv（回滚路径）。 */
export function authMode(env: { AUTH_MODE?: string }): 'signed' | 'kv' {
  return (env.AUTH_MODE ?? 'signed').toLowerCase() === 'kv' ? 'kv' : 'signed';
}
