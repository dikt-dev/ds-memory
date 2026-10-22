import { describe, expect, it } from 'vitest';
import { hashPassword, randomHex, sha256Hex, verifyPassword } from './auth';

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
