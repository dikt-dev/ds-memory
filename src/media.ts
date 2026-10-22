/**
 * 图片处理：
 * - 接收（网页 data URL / AstrBot 的图片 URL）→ 服务端压缩（最长边 1024px、JPEG 0.70）→ 存 R2 images/{日期}/{时间戳}.jpg
 * - 聊天记录（D1）只记录 R2 路径标记 [图片:images/…]
 * - 发给 DeepSeek 的图片从 R2 读回后转 base64 data URL
 */
import type { Env } from './types';
import jpeg from 'jpeg-js';
import UPNG from 'upng-js';
import { getObject, headObject, putObject } from './storage';

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 单图上限（压缩前）
export const MAX_IMAGE_SIDE = 1024; // 压缩后最长边
export const IMAGE_QUALITY = 0.7; // JPEG 质量
/** 已足够小的 JPEG 跳过重压缩（避免二次损失） */
export const COMPRESS_MIN_BYTES = 120 * 1024;

const DATA_URL_RE = /^data:(image\/(?:png|jpeg|jpg|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/i;

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

export interface ParsedImage {
  mime: string;
  ext: string;
  bytes: Uint8Array;
}

/** 解析 data URL（纯函数，可单测）。 */
export function parseDataUrl(dataUrl: string): ParsedImage | null {
  const m = DATA_URL_RE.exec(dataUrl.trim());
  if (!m) return null;
  const mime = m[1].toLowerCase();
  const ext = EXT_BY_MIME[mime];
  if (!ext) return null;
  const base64 = m[2].replace(/\s+/g, '');
  if (!base64) return null;
  let bytes: Uint8Array;
  try {
    const binary = atob(base64);
    bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  } catch {
    return null;
  }
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) return null;
  return { mime, ext, bytes };
}

/** 生成图片对象键：images/{日期}/{时间戳}.{ext}（时间戳 = epoch 毫秒）。 */
export function buildImageKey(dateKey: string, ms: number, ext: string): string {
  return `images/${dateKey}/${ms}.${ext}`;
}

/** 最近邻区域平均缩放（RGBA）。 */
function downscaleRGBA(src: Uint8Array, sw: number, sh: number, dw: number, dh: number): Uint8Array {
  const out = new Uint8Array(dw * dh * 4);
  const xRatio = sw / dw;
  const yRatio = sh / dh;
  for (let y = 0; y < dh; y++) {
    const sy0 = Math.floor(y * yRatio);
    const sy1 = Math.min(sh, Math.max(sy0 + 1, Math.floor((y + 1) * yRatio)));
    for (let x = 0; x < dw; x++) {
      const sx0 = Math.floor(x * xRatio);
      const sx1 = Math.min(sw, Math.max(sx0 + 1, Math.floor((x + 1) * xRatio)));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const i = (sy * sw + sx) * 4;
          r += src[i];
          g += src[i + 1];
          b += src[i + 2];
          a += src[i + 3];
          n++;
        }
      }
      const o = (y * dw + x) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = Math.round(a / n);
    }
  }
  return out;
}

/**
 * 服务端压缩：JPEG/PNG → 缩小到最长边 1024、重新编码为 JPEG 0.70。
 * 已很小 / 不支持的格式返回 null（调用方使用原图）。
 */
export function compressImageBytes(
  bytes: Uint8Array,
  mime: string,
): { bytes: Uint8Array; ext: string; mime: string } | null {
  const isJpeg = mime === 'image/jpeg' || mime === 'image/jpg';
  if (isJpeg && bytes.length <= COMPRESS_MIN_BYTES) return null;
  try {
    let width = 0;
    let height = 0;
    let rgba: Uint8Array;
    if (isJpeg) {
      const dec = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true });
      width = dec.width;
      height = dec.height;
      rgba = dec.data;
    } else if (mime === 'image/png') {
      const dec = UPNG.decode(bytes);
      const frames = UPNG.toRGBA8(dec);
      rgba = new Uint8Array(frames[0]);
      width = dec.width;
      height = dec.height;
    } else {
      return null;
    }
    const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(width, height));
    if (scale < 1) {
      const nw = Math.max(1, Math.round(width * scale));
      const nh = Math.max(1, Math.round(height * scale));
      rgba = downscaleRGBA(rgba, width, height, nw, nh);
      width = nw;
      height = nh;
    }
    const encoded = jpeg.encode({ data: rgba, width, height }, Math.round(IMAGE_QUALITY * 100)) as {
      data: Uint8Array;
    };
    return { bytes: new Uint8Array(encoded.data), ext: 'jpg', mime: 'image/jpeg' };
  } catch {
    return null;
  }
}

async function putImage(
  env: Env,
  bytes: Uint8Array,
  ext: string,
  mime: string,
  dateKey: string,
  at: Date,
): Promise<string> {
  let ms = at.getTime();
  let key = buildImageKey(dateKey, ms, ext);
  for (let i = 0; i < 5; i++) {
    if (!(await headObject(env, key))) break;
    ms += 1;
    key = buildImageKey(dateKey, ms, ext);
  }
  await putObject(env, key, bytes, { contentType: mime });
  return key;
}

/** 网页上传（data URL）：解析 → 压缩 → 存 R2。返回 R2 键。 */
export async function saveImage(
  env: Env,
  dataUrl: string,
  dateKey: string,
  at: Date = new Date(),
): Promise<{ key: string; mime: string } | null> {
  const parsed = parseDataUrl(dataUrl);
  if (!parsed) return null;
  const compressed = compressImageBytes(parsed.bytes, parsed.mime);
  const key = await putImage(
    env,
    compressed?.bytes ?? parsed.bytes,
    compressed?.ext ?? parsed.ext,
    compressed?.mime ?? parsed.mime,
    dateKey,
    at,
  );
  return { key, mime: compressed?.mime ?? parsed.mime };
}

/**
 * AstrBot 等来源：data URL / http(s) URL / base64 裸串 → 压缩 → 存 R2。返回 R2 键。
 * 注意：本地文件路径（如 /root/data/temp/xxx.jpg）Worker 无法访问，返回 null。
 */
export async function saveImageFromSource(
  env: Env,
  src: string,
  dateKey: string,
  at: Date = new Date(),
): Promise<{ key: string; mime: string } | null> {
  if (!src) return null;
  if (src.startsWith('data:')) return saveImage(env, src, dateKey, at);

  // 裸 base64（AstrBot 某些适配器会这样传）：尝试按 JPEG/PNG 魔数识别
  if (!/^https?:\/\//i.test(src) && /^[A-Za-z0-9+/=\s]+$/.test(src) && src.length > 200) {
    const mime = src.startsWith('/9j/') ? 'image/jpeg' : src.startsWith('iVBOR') ? 'image/png' : null;
    if (mime) return saveImage(env, `data:${mime};base64,${src}`, dateKey, at);
    return null;
  }

  if (!/^https?:\/\//i.test(src)) return null; // 本地路径等无法访问
  try {
    const res = await fetch(src);
    if (!res.ok) return null;
    const declared = Number(res.headers.get('content-length') ?? '0');
    if (declared > MAX_IMAGE_BYTES) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > MAX_IMAGE_BYTES) return null;
    const contentType = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    const mime = contentType.startsWith('image/') ? contentType : 'image/jpeg';
    const ext = EXT_BY_MIME[mime] ?? 'jpg';
    const compressed = compressImageBytes(buf, mime);
    const key = await putImage(env, compressed?.bytes ?? buf, compressed?.ext ?? ext, compressed?.mime ?? mime, dateKey, at);
    return { key, mime: compressed?.mime ?? mime };
  } catch {
    return null;
  }
}

function base64FromUint8Array(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(binary);
}

/** 从 R2 读回图片并转为 data URL（发给 DeepSeek）。 */
export async function loadImageDataUrl(
  env: Env,
  key: string,
): Promise<{ dataUrl: string; mime: string } | null> {
  const obj = await getObject(env, key);
  if (!obj) return null;
  const buf = new Uint8Array(await obj.arrayBuffer());
  const mime = obj.httpMetadata?.contentType ?? 'image/jpeg';
  return { dataUrl: `data:${mime};base64,${base64FromUint8Array(buf)}`, mime };
}
