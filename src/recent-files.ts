/**
 * 最近发过的文件（沉淀用）。
 *
 * 为什么需要：文件正文只跟着那一轮请求走，历史消息被压缩成 400 字以后，
 * 「上次那个表格」就彻底对不上了。这里只存**文件名 + 字数**，很便宜，
 * 却能让模型在一周内认出「你说的是哪个文件」。
 *
 * 存储：KV files:recent（最多 8 条，7 天过期）。
 */
import type { Env } from './types';

export interface FileDigest {
  name: string;
  chars: number;
  at: string;
}

const KEY = 'files:recent';
const MAX_FILES = 8;
const MAX_AGE_DAYS = 7;

function parse(input: unknown): FileDigest[] {
  if (!Array.isArray(input)) return [];
  const out: FileDigest[] = [];
  for (const raw of input.slice(0, 5)) {
    if (!raw || typeof raw !== 'object') continue;
    const o = raw as { name?: unknown; chars?: unknown };
    const name = typeof o.name === 'string' ? o.name.slice(0, 120).trim() : '';
    if (!name) continue;
    const chars = typeof o.chars === 'number' && o.chars > 0 ? Math.floor(o.chars) : 0;
    out.push({ name, chars, at: new Date().toISOString() });
  }
  return out;
}

/** 记录本轮发来的文件（同名文件只保留最新一条）。 */
export async function recordFiles(env: Env, files: unknown): Promise<void> {
  const incoming = parse(files);
  if (incoming.length === 0) return;
  const prev = ((await env.KV.get(KEY, 'json').catch(() => null)) as FileDigest[] | null) ?? [];
  const names = new Set(incoming.map((f) => f.name));
  const merged = [...incoming, ...prev.filter((f) => !names.has(f.name))].slice(0, MAX_FILES);
  await env.KV
    .put(KEY, JSON.stringify(merged), { expirationTtl: MAX_AGE_DAYS * 86400 })
    .catch(() => {});
}

/** 生成提示词里的「最近发过的文件」块；没有则返回 null。 */
export async function recentFilesBlock(env: Env, now: Date): Promise<string | null> {
  const list = ((await env.KV.get(KEY, 'json').catch(() => null)) as FileDigest[] | null) ?? [];
  if (!Array.isArray(list) || list.length === 0) return null;
  const fresh = list
    .filter((f) => f && typeof f.name === 'string')
    .filter((f) => now.getTime() - Date.parse(f.at) < MAX_AGE_DAYS * 86400000)
    .slice(0, 6);
  if (fresh.length === 0) return null;
  const lines = fresh.map((f) => `- ${f.name}${f.chars ? `（约 ${f.chars} 字）` : ''}`);
  return [
    '## 最近发过的文件',
    '（用户近几天发过这些文件；被问到「上次那个/那个表」时按名字对上，内容细节以当时对话为准。）',
    ...lines,
  ].join('\n');
}
