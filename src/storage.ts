/**
 * 统一对象存储：主账号 R2（Worker 绑定）+ 小号 R2（S3 兼容 API，aws4fetch 签名）。
 * - 主账号空间达到阈值后（每日容量检查），新写入自动切换到小号；
 * - 读取主账号优先、小号兜底（历史对象留在主账号）；
 * - 删除/列出两个桶都会处理（合并去重）。
 */
import type { Env } from './types';
import { AwsClient } from 'aws4fetch';

export type StorageMode = 'main' | 'secondary';
export const STORAGE_MODE_KV = 'storage:mode';
export const STORAGE_USAGE_KV = 'storage:usage';
const USAGE_CACHE_MS = 6 * 60 * 60 * 1000;
/** 主账号占用达到该值后切换小号（默认 8.5GB） */
export const STORAGE_THRESHOLD_DEFAULT = 8.5 * 1024 * 1024 * 1024;

export function secondaryEnabled(env: Env): boolean {
  return Boolean(
    env.SECONDARY_R2_ACCOUNT_ID &&
      env.SECONDARY_R2_BUCKET &&
      env.SECONDARY_R2_ACCESS_KEY_ID &&
      env.SECONDARY_R2_SECRET_ACCESS_KEY,
  );
}

const clients = new WeakMap<Env, AwsClient>();
function s3Client(env: Env): AwsClient {
  let client = clients.get(env);
  if (!client) {
    client = new AwsClient({
      accessKeyId: env.SECONDARY_R2_ACCESS_KEY_ID as string,
      secretAccessKey: env.SECONDARY_R2_SECRET_ACCESS_KEY as string,
      service: 's3',
      region: 'auto',
    });
    clients.set(env, client);
  }
  return client;
}

function s3Url(env: Env, key: string): string {
  const encoded = key
    .split('/')
    .map((p) => encodeURIComponent(p))
    .join('/');
  return `https://${env.SECONDARY_R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.SECONDARY_R2_BUCKET}/${encoded}`;
}

export async function getStorageMode(env: Env): Promise<StorageMode> {
  try {
    return (await env.KV.get(STORAGE_MODE_KV)) === 'secondary' ? 'secondary' : 'main';
  } catch {
    return 'main';
  }
}

export async function setStorageMode(env: Env, mode: StorageMode): Promise<void> {
  await env.KV.put(STORAGE_MODE_KV, mode);
}

export interface StoredObject {
  size: number;
  httpMetadata?: { contentType?: string };
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** 写对象：按当前模式写入主账号或小号。 */
export async function putObject(
  env: Env,
  key: string,
  body: string | Uint8Array | ArrayBuffer,
  opts?: { contentType?: string },
): Promise<void> {
  if ((await getStorageMode(env)) === 'secondary' && secondaryEnabled(env)) {
    const res = await s3Client(env).fetch(s3Url(env, key), {
      method: 'PUT',
      headers: opts?.contentType ? { 'content-type': opts.contentType } : undefined,
      body,
    });
    if (!res.ok) throw new Error(`secondary R2 put failed: ${res.status}`);
    return;
  }
  await env.R2.put(key, body, opts?.contentType ? { httpMetadata: { contentType: opts.contentType } } : undefined);
}

/** 读对象：主账号优先，小号兜底。 */
export async function getObject(env: Env, key: string): Promise<StoredObject | null> {
  const main = await env.R2.get(key).catch(() => null);
  if (main) return main;
  if (!secondaryEnabled(env)) return null;
  const res = await s3Client(env).fetch(s3Url(env, key)).catch(() => null);
  if (!res || res.status === 404 || !res.ok) return null;
  const buf = await res.arrayBuffer();
  return {
    size: buf.byteLength,
    httpMetadata: { contentType: res.headers.get('content-type') ?? undefined },
    text: async () => new TextDecoder().decode(buf),
    arrayBuffer: async () => buf,
  };
}

export async function headObject(env: Env, key: string): Promise<{ size: number } | null> {
  const main = await env.R2.head(key).catch(() => null);
  if (main) return { size: main.size };
  if (!secondaryEnabled(env)) return null;
  const res = await s3Client(env).fetch(s3Url(env, key), { method: 'HEAD' }).catch(() => null);
  if (!res || !res.ok) return null;
  return { size: Number(res.headers.get('content-length') ?? 0) };
}

/** 删除对象：两个桶都尝试删除（历史数据可能残留）。 */
export async function deleteObject(env: Env, key: string): Promise<void> {
  await env.R2.delete(key).catch(() => {});
  if (!secondaryEnabled(env)) return;
  await s3Client(env).fetch(s3Url(env, key), { method: 'DELETE' }).catch(() => {});
}

/** 列出对象键（主账号 + 小号合并去重）。 */
export async function listKeys(env: Env, prefix: string): Promise<string[]> {
  const keys = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await env.R2.list({ prefix, cursor });
    for (const o of page.objects) keys.add(o.key);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  if (secondaryEnabled(env)) {
    let token: string | undefined;
    do {
      const url = new URL(s3Url(env, ''));
      url.searchParams.set('list-type', '2');
      if (prefix) url.searchParams.set('prefix', prefix);
      url.searchParams.set('max-keys', '1000');
      if (token) url.searchParams.set('continuation-token', token);
      const res = await s3Client(env).fetch(url.toString()).catch(() => null);
      if (!res || !res.ok) break;
      const xml = await res.text();
      for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) keys.add(m[1]);
      token = /<IsTruncated>true<\/IsTruncated>/.test(xml)
        ? /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml)?.[1]
        : undefined;
    } while (token);
  }
  return [...keys];
}

/**
 * 清理过期的 context/ 对象（每日归档时调用）。
 * - context/YYYY-MM-DD.json 保留 90 天（便于回溯最近季度）
 * - 不动 memory.md、chat_logs/（由月度合并自己管理）、images/（用户图片保留）
 */
export async function cleanupStaleObjects(
  env: Env,
  now: Date,
  keepDays = 90,
): Promise<{ deleted: number }> {
  const cutoff = new Date(now.getTime() - keepDays * 86400000);
  const cutoffKey = dateKeyFromDate(cutoff);
  let deleted = 0;

  const keys = await listKeys(env, 'context/');
  const stale = keys.filter((k) => {
    const m = /^context\/(\d{4}-\d{2}-\d{2})\.json$/.exec(k);
    if (!m) return false;
    return m[1] < cutoffKey;
  });
  for (const key of stale) {
    await deleteObject(env, key);
    deleted += 1;
  }
  if (deleted > 0) console.log(`[r2] 清理过期 context ${deleted} 个（早于 ${cutoffKey}）`);
  return { deleted };
}

function dateKeyFromDate(d: Date): string {
  const [y, m, dd] = [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()];
  return `${y}-${String(m).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}

/** 主账号 R2 已用字节数（分页统计，结果缓存 6 小时）。 */
export async function getMainUsageBytes(env: Env): Promise<number> {
  try {
    const cached = await env.KV.get(STORAGE_USAGE_KV);
    if (cached) {
      const parsed = JSON.parse(cached) as { bytes: number; at: string };
      if (Number.isFinite(parsed.bytes) && Date.now() - new Date(parsed.at).getTime() < USAGE_CACHE_MS) {
        return parsed.bytes;
      }
    }
  } catch {
    /* ignore */
  }
  let bytes = 0;
  let cursor: string | undefined;
  do {
    const page = await env.R2.list({ cursor });
    for (const o of page.objects) bytes += o.size;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  await env.KV.put(STORAGE_USAGE_KV, JSON.stringify({ bytes, at: new Date().toISOString() })).catch(() => {});
  return bytes;
}

export interface CapacityCheck {
  usage: number;
  threshold: number;
  mode: StorageMode;
  switched: boolean;
}

/** 容量检查：主账号达到阈值且已配置小号时，把新写入切换到小号。 */
export async function checkStorageCapacity(env: Env): Promise<CapacityCheck> {
  const usage = await getMainUsageBytes(env);
  const threshold = Number(env.STORAGE_THRESHOLD_BYTES) || STORAGE_THRESHOLD_DEFAULT;
  let mode = await getStorageMode(env);
  let switched = false;
  if (mode === 'main' && usage >= threshold && secondaryEnabled(env)) {
    await setStorageMode(env, 'secondary');
    mode = 'secondary';
    switched = true;
    console.log('[storage] main R2 usage', usage, '>= threshold', threshold, '→ switched to secondary');
  }
  return { usage, threshold, mode, switched };
}
