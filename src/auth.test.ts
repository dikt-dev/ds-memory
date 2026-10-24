import { describe, expect, it } from 'vitest';
import type { Env } from './types';
import {
  AUTH_TOKEN_TTL_SECONDS,
  hashPassword,
  isAuthTokenRevoked,
  randomHex,
  resetAuthRevocationCache,
  revokeAllAuth,
  sha256Hex,
  signAuthToken,
  verifyAuthToken,
  verifyPassword,
} from './auth';

describe('auth', () => {
  it('口令哈希可往返验证', async () => {
    const stored = await hashPassword('secret123');
    expect(stored.split(':')).toHaveLength(2);
    expect(await verifyPassword('secret123', stored)).toBe(true);
    expect(await verifyPassword('wrong-password', stored)).toBe(false);
  });

  it('固定盐可复现（与 scripts/hash-password.mjs 兼容）', async () => {
    const a = await hashPassword('pw', 'deadbeef');
    const b = await hashPassword('pw', 'deadbeef');
    expect(a).toBe(b);
  });

  it('畸形存储值返回 false', async () => {
    expect(await verifyPassword('x', 'no-colon-here')).toBe(false);
    expect(await verifyPassword('x', ':')).toBe(false);
  });

  it('登录 token 为 64 位十六进制', () => {
    expect(randomHex(32)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('sha256 已知向量（"abc"）', async () => {
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('无状态签名 token', () => {
  const secret = 'phase1-test-secret';
  const now = Date.UTC(2026, 9, 24, 12, 0, 0);

  it('签发后可验证，TTL 为 24h', async () => {
    const { token, payload } = await signAuthToken(secret, now);
    expect(payload.exp - payload.iat).toBe(AUTH_TOKEN_TTL_SECONDS);
    const verified = await verifyAuthToken(token, secret, now + 1000);
    expect(verified?.iat).toBe(payload.iat);
    expect(verified?.jti).toBe(payload.jti);
  });

  it('篡改/错误密钥/过期都失败', async () => {
    const { token } = await signAuthToken(secret, now);
    expect(await verifyAuthToken(`${token}x`, secret, now)).toBeNull();
    expect(await verifyAuthToken(token, 'wrong-secret', now)).toBeNull();
    expect(await verifyAuthToken(token, secret, now + AUTH_TOKEN_TTL_SECONDS * 1000 + 1000)).toBeNull();
  });

  it('畸形 token 不抛错', async () => {
    expect(await verifyAuthToken('', secret, now)).toBeNull();
    expect(await verifyAuthToken('abc', secret, now)).toBeNull();
    expect(await verifyAuthToken('a.b.c', secret, now)).toBeNull();
  });
});

describe('全局吊销（全部登出）', () => {
  const kvStore = new Map<string, string>();
  const env = {
    KV: {
      get: async (key: string) => kvStore.get(key) ?? null,
      put: async (key: string, value: string) => {
        kvStore.set(key, value);
      },
    },
  } as unknown as Env;

  it('吊销时间之前的 token 失效，之后的仍有效', async () => {
    resetAuthRevocationCache();
    const now = Date.UTC(2026, 9, 24, 12, 0, 0);
    await revokeAllAuth(env, now);
    resetAuthRevocationCache();
    const oldPayload = { v: 1 as const, iat: Math.floor(now / 1000) - 10, exp: 0, jti: 'a' };
    const newPayload = { v: 1 as const, iat: Math.floor(now / 1000) + 10, exp: 0, jti: 'b' };
    expect(await isAuthTokenRevoked(env, oldPayload)).toBe(true);
    expect(await isAuthTokenRevoked(env, newPayload)).toBe(false);
    resetAuthRevocationCache();
  });
});
