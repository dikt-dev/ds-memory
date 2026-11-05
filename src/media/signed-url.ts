/**
 * 短期签名 URL：给外部多模态模型（千问 omni）下载 R2 里的视频用。
 *
 * 这些模型的 video_url 只认公网可直接 GET 的地址，不收 base64，也带不了我们的
 * 设备 Token。所以签一个自带过期时间和 HMAC 的路径，10 分钟内有效，过期即失效。
 * 路径里只允许 videos/ 和 gifs/，别的 key 一律拒绝。
 */
const enc = new TextEncoder();

function toB64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export const MEDIA_TTL_SEC = 600;

async function hmacHex(secret: string, data: string): Promise<string> {
  const k = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', k, enc.encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 生成 /m/<payload>.<sig>。ttlSec 默认 10 分钟。 */
export async function signMediaPath(
  secret: string,
  key: string,
  ttlSec: number = MEDIA_TTL_SEC,
  nowMs: number = Date.now(),
): Promise<string> {
  const exp = Math.floor(nowMs / 1000) + ttlSec;
  const payload = toB64url(enc.encode(`${key}|${exp}`));
  const sig = (await hmacHex(secret, payload)).slice(0, 32);
  return `/m/${payload}.${sig}`;
}

/** 校验并取回 R2 key；过期、签名不符、前缀不对都返回 null。 */
export async function verifyMediaToken(
  secret: string,
  token: string,
  nowMs: number = Date.now(),
): Promise<string | null> {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expect = (await hmacHex(secret, payload)).slice(0, 32);
  if (sig.length !== expect.length) return null;
  let diff = 0;
  for (let i = 0; i < sig.length; i += 1) diff |= sig.charCodeAt(i) ^ expect.charCodeAt(i);
  if (diff !== 0) return null;
  let decoded = '';
  try {
    decoded = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
  } catch {
    return null;
  }
  const bar = decoded.lastIndexOf('|');
  if (bar <= 0) return null;
  const key = decoded.slice(0, bar);
  const exp = Number(decoded.slice(bar + 1));
  if (!Number.isFinite(exp) || exp * 1000 < nowMs) return null;
  if (!/^(videos|gifs)\//.test(key) || key.includes('..') || key.length > 200) return null;
  return key;
}
