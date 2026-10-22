/**
 * 口令鉴权（Web Crypto SHA-256 + 随机盐）。
 * 存储格式：`salt:hash`（与 scripts/hash-password.mjs 一致）。
 * 单用户硬性约束：只校验口令，不区分用户，永不支持注册。
 */

const encoder = new TextEncoder();

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
