/**
 * 记忆条目索引层（常驻核心 + 按需检索注入）。
 *
 * 设计目标：memory.md / archive.md 无限扩张（本体，永久完整），
 * 每次聊天只注入「核心层 + 中期 + 短期 + 召回 top-k」，
 * 让 token 与记忆总量解耦。
 *
 * 数据流：
 *   memory.md / archive.md ──(解析)──> D1 memory_entries（可重建索引）
 *   聊天时：关键词 bigram + 标签 + 同义词（确定性）+ 语义向量（可选）双路召回
 *
 * 保障：索引不是本体。任何时刻都能从 R2 重建；embedding 失败自动降级为关键词召回。
 */
import type { Env } from './types';
import { getMemory } from './memory';
import {
  aliasTerms,
  autoTags,
  bigrams,
  expandQuery,
  extractTags,
  getArchiveLines,
  strongWords,
  stripTags,
} from './memory-archive';
import { DATE_PREFIX_RE, ENTRY_RE, normalizeDateKey } from './memory-maintenance';

/** 永远常驻注入、不参与检索的分区（核心层）。 */
export const CORE_SECTIONS = ['人物底色', '称呼与关系', '雷区与禁忌'];

/** 单次聊天注入的召回条数上限。 */
export const RECALL_TOP_K = 6;

/** 默认语义向量模型（多语言；失败自动降级关键词召回）。 */
export const DEFAULT_EMBEDDING_MODEL = '@cf/baai/bge-m3';

export interface MemoryEntryRow {
  id: string;
  section: string;
  content: string;
  date: string | null;
  importance: number;
  tags: string[];
  keywords: string[];
  /** 存储态向量：int8 量化 JSON（{min,max,b:base64}），或旧版 float 数组 JSON */
  vec: string | null;
  source: 'memory' | 'archive';
}

interface ParsedEntry {
  section: string;
  content: string;
  date: string | null;
  source: 'memory' | 'archive';
}

/** 从 memory.md 里抽出「常驻核心」区块（人物底色/称呼与关系/雷区与禁忌）。 */
export function extractCoreMemory(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let current = '';
  for (const line of lines) {
    const m = line.match(/^##\s+(.*)$/);
    if (m) {
      current = m[1].trim();
    }
    if (current && CORE_SECTIONS.includes(current)) out.push(line);
  }
  return out.join('\n').trim();
}

/** 把记忆文本解析成条目（非核心分区才进索引）。 */
export function parseMemoryEntries(
  text: string,
  source: 'memory' | 'archive',
): ParsedEntry[] {
  const out: ParsedEntry[] = [];
  let section = source === 'archive' ? '档案' : '';
  for (const raw of text.split('\n')) {
    const hm = raw.match(/^##\s+(.*)$/);
    if (hm) {
      section = hm[1].trim();
      continue;
    }
    const line = raw.trim();
    if (!line || line.startsWith('<!--') || line.startsWith('>') || line.startsWith('#')) continue;
    if (!/^-\s/.test(line)) continue;
    const em = line.match(ENTRY_RE);
    const content = line
      .replace(/^-\s*/, '')
      .replace(DATE_PREFIX_RE, '')
      .trim();
    if (!content) continue;
    // 关系数值行只属于核心层，不进索引
    if (/^(好感度|亲密度|心情值?)\s*[:：]/.test(content)) continue;
    if (CORE_SECTIONS.includes(section)) continue;
    const date = em ? normalizeDateKey(em[1]) : null;
    out.push({ section, content, date, source });
  }
  return out;
}

function hashId(section: string, date: string | null, content: string): string {
  let h = 0x811c9dc5;
  const s = `${section}|${date ?? ''}|${content}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `me_${(h >>> 0).toString(36)}_${s.length}`;
}

async function embedTexts(env: Env, texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const model = env.EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL;
  try {
    const res = (await env.AI.run(model as never, { text: texts })) as {
      data?: number[][];
    };
    if (Array.isArray(res?.data) && res.data.length === texts.length) return res.data;
  } catch (e) {
    console.warn('[memory-index] embedding failed, fallback to keyword recall:', e);
  }
  return [];
}

/** 重建 D1 记忆索引（可重复执行，幂等）。 */
export async function reindexMemory(
  env: Env,
): Promise<{ entries: number; withVec: number; errors: string | null }> {
  try {
    const memory = await getMemory(env);
    const archiveLines = await getArchiveLines(env);
    const parsed = [
      ...parseMemoryEntries(memory, 'memory'),
      ...parseMemoryEntries(archiveLines.join('\n'), 'archive'),
    ];

    // 同内容去重（保留 memory 优先）
    const seen = new Map<string, ParsedEntry>();
    for (const p of parsed) {
      const key = `${p.section}|${p.content}`;
      if (!seen.has(key) || p.source === 'memory') seen.set(key, p);
    }
    const entries = [...seen.values()];

    const existing = await env.DB.prepare('SELECT id, vec FROM memory_entries').all<{
      id: string;
      vec: string | null;
    }>();
    const have = new Set((existing.results ?? []).map((r) => r.id));
    const vecMap = new Map<string, string | null>(
      (existing.results ?? []).map((r) => [r.id, r.vec]),
    );

    const now = Date.now();
    const toEmbed: Array<{ id: string; text: string }> = [];
    const rows: MemoryEntryRow[] = entries.map((p) => {
      const id = hashId(p.section, p.date, p.content);
      const tags = autoTags(p.content, 3);
      const isNew = !have.has(id);
      const row: MemoryEntryRow = {
        id,
        section: p.section,
        content: p.content,
        date: p.date,
        importance: 2,
        tags,
        keywords: [],
        vec: null,
        source: p.source,
      };
      if (isNew) {
        toEmbed.push({ id, text: `${p.section}：${p.content}` });
      } else {
        // 保留已有向量；旧版 float 数组就地转 int8，缺向量才重新计算
        const parsed = decodeVec(vecMap.get(id) ?? null);
        if (parsed) {
          row.vec = quantizeVec(parsed);
        } else {
          toEmbed.push({ id, text: `${p.section}：${p.content}` });
        }
      }
      return row;
    });

    // 批量向量化（每批 20 条）
    for (let i = 0; i < toEmbed.length; i += 20) {
      const batch = toEmbed.slice(i, i + 20);
      const vecs = await embedTexts(
        env,
        batch.map((b) => b.text),
      );
      batch.forEach((b, j) => {
        if (vecs[j]) {
          const row = rows.find((r) => r.id === b.id);
          if (row) row.vec = quantizeVec(vecs[j]);
        }
      });
    }

    const stmt = env.DB.prepare(
      `INSERT OR REPLACE INTO memory_entries
       (id, section, content, date, importance, tags, keywords, vec, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (let i = 0; i < rows.length; i += 100) {
      const chunk = rows.slice(i, i + 100);
      await env.DB.batch(
        chunk.map((r) =>
          stmt.bind(
            r.id,
            r.section,
            r.content,
            r.date,
            r.importance,
            JSON.stringify(r.tags),
            JSON.stringify(r.keywords),
            r.vec,
            r.source,
            now,
            now,
          ),
        ),
      );
    }
    // 清理"幽灵条目"：本体里已经删掉/改掉的旧行，不能再被召回
    const currentIds = new Set(rows.map((r) => r.id));
    const staleIds = [...have].filter((id) => !currentIds.has(id));
    for (let i = 0; i < staleIds.length; i += 100) {
      const chunk = staleIds.slice(i, i + 100);
      await env.DB.batch(
        chunk.map((id) => env.DB.prepare('DELETE FROM memory_entries WHERE id = ?').bind(id)),
      );
    }

    const vecCount = await env.DB.prepare(
      'SELECT COUNT(*) AS c FROM memory_entries WHERE vec IS NOT NULL',
    ).first<{ c: number }>();
    // 预热缓存：isolate 内存 + KV（跨 isolate）
    rowsCache = { key: `${rows.length}|${now}`, rows };
    memCache = { key: 'reindex', rows, at: now };
    await putIndexKv(env, rows);
    return { entries: rows.length, withVec: vecCount?.c ?? 0, errors: null };
  } catch (e) {
    console.error('[memory-index] reindex failed:', e);
    return { entries: 0, withVec: 0, errors: e instanceof Error ? e.message : String(e) };
  }
}

function cosine(a: number[], b: number[]): number {
  if (!a || !b || a.length === 0 || b.length === 0) return 0;
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/* ---------- int8 量化：1024 维 float 数组 → 约 1.4KB JSON ---------- */

interface QuantizedVec {
  min: number;
  max: number;
  b: string; // Int8Array 的 base64
}

/** 把 float 向量量化成 int8（-128~127），cosine 基本不变，体积约省 60%。 */
export function quantizeVec(vec: number[]): string | null {
  if (!vec || vec.length === 0) return null;
  let min = Infinity;
  let max = -Infinity;
  for (const v of vec) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const range = max - min || 1;
  const bytes = new Uint8Array(vec.length);
  for (let i = 0; i < vec.length; i++) {
    bytes[i] = Math.round(((vec[i] - min) / range) * 255) & 0xff;
  }
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return JSON.stringify({ min, max, b: btoa(bin) });
}

/** 解码存储态向量：兼容旧版 float 数组 JSON 与新版 int8 JSON。 */
export function decodeVec(raw: string | null): number[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as number[] | QuantizedVec;
    if (Array.isArray(parsed)) return parsed; // 旧格式
    if (typeof parsed === 'object' && parsed && typeof parsed.b === 'string') {
      const bin = atob(parsed.b);
      const range = (parsed.max ?? 1) - (parsed.min ?? 0) || 1;
      const out: number[] = [];
      for (let i = 0; i < bin.length; i++) {
        out.push(parsed.min + (bin.charCodeAt(i) / 255) * range);
      }
      return out;
    }
  } catch {
    /* ignore */
  }
  return null;
}

let rowsCache: { key: string; rows: MemoryEntryRow[] } | null = null;

const INDEX_KV_KEY = 'memory:index';
const INDEX_KV_TTL_SECONDS = 3600;
const MEM_CACHE_TTL_MS = 5 * 60 * 1000;
const KV_INDEX_MAX_BYTES = 20 * 1024 * 1024; // KV 单值上限 25MB，留余量

interface MemCache {
  key: string;
  rows: MemoryEntryRow[];
  at: number;
}
let memCache: MemCache | null = null;
const qvecMem = new Map<string, number[]>();

async function putIndexKv(env: Env, rows: MemoryEntryRow[]): Promise<void> {
  try {
    let payload = JSON.stringify({ v: 1, at: Date.now(), rows });
    if (payload.length > KV_INDEX_MAX_BYTES) {
      // 太大就丢弃向量，关键词召回仍可用（向量路径只在 D1 回源时生效）
      console.warn('[memory-index] KV index too large, dropping vec in cache');
      payload = JSON.stringify({
        v: 1,
        at: Date.now(),
        rows: rows.map((r) => ({ ...r, vec: null })),
      });
    }
    await env.KV.put(INDEX_KV_KEY, payload, { expirationTtl: INDEX_KV_TTL_SECONDS }).catch(() => {});
  } catch (e) {
    console.warn('[memory-index] putIndexKv failed:', e);
  }
}

async function readIndexKv(env: Env): Promise<MemoryEntryRow[] | null> {
  try {
    const raw = await env.KV.get(INDEX_KV_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { v?: number; rows?: MemoryEntryRow[] };
    if (parsed?.v !== 1 || !Array.isArray(parsed.rows)) return null;
    return parsed.rows;
  } catch {
    return null;
  }
}

async function loadRows(env: Env): Promise<MemoryEntryRow[]> {
  // ① isolate 内存缓存（存活期间 0 IO）
  if (memCache && Date.now() - memCache.at < MEM_CACHE_TTL_MS) return memCache.rows;

  // ② KV 热缓存（跨请求、跨 isolate）
  const kvRows = await readIndexKv(env);
  if (kvRows) {
    memCache = { key: 'kv', rows: kvRows, at: Date.now() };
    return kvRows;
  }

  // ③ D1 回源并回写 KV
  const meta = await env.DB.prepare(
    'SELECT COUNT(*) AS c, COALESCE(MAX(updated_at), 0) AS m FROM memory_entries',
  ).first<{ c: number; m: number }>();
  const key = `${meta?.c ?? 0}|${meta?.m ?? 0}`;
  if (rowsCache && rowsCache.key === key) return rowsCache.rows;
  const all = await env.DB.prepare(
    'SELECT id, section, content, date, importance, tags, keywords, vec, source FROM memory_entries ORDER BY updated_at DESC',
  ).all<{
    id: string;
    section: string;
    content: string;
    date: string | null;
    importance: number;
    tags: string;
    keywords: string;
    vec: string | null;
    source: string;
  }>();
  const rows: MemoryEntryRow[] = (all.results ?? []).map((r) => ({
    id: r.id,
    section: r.section,
    content: r.content,
    date: r.date,
    importance: r.importance,
    tags: safeJson(r.tags),
    keywords: safeJson(r.keywords),
    vec: r.vec,
    source: r.source === 'archive' ? 'archive' : 'memory',
  }));
  rowsCache = { key, rows };
  memCache = { key, rows, at: Date.now() };
  await putIndexKv(env, rows);
  return rows;
}

function safeJson<T>(s: string): T {
  try {
    return JSON.parse(s) as T;
  } catch {
    return [] as unknown as T;
  }
}

/** 按当前话题召回 top-k 条记忆（双路打分，无命中回退最近条目）。 */
export async function recallMemoryForChat(
  env: Env,
  query: string,
  k = RECALL_TOP_K,
): Promise<string> {
  const q = (query || '').slice(-1000).trim();
  if (!q) return '';
  try {
    const rows = await loadRows(env);
    if (rows.length === 0) return '';

    const qGrams = new Set(bigrams(q));
    const qWords = new Set(strongWords(q).filter((w) => w.length >= 3));
    const aliases = new Set(aliasTerms(q));
    const tagCtx = expandQuery(q).toLowerCase();

    let qVec: number[] | null = null;
    // 查询向量缓存：先内存，再 KV（1h），都没有才调 AI
    const qKey = `memory:qvec:${hashId('q', null, q.slice(0, 200))}`;
    const cachedQ = qvecMem.get(qKey);
    if (cachedQ) {
      qVec = cachedQ.length > 0 ? cachedQ : null;
    } else {
      try {
        const kvQ = (await env.KV.get(qKey, 'json').catch(() => null)) as number[] | null;
        if (Array.isArray(kvQ) && kvQ.length > 0) {
          qVec = kvQ;
        } else {
          const model = env.EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL;
          const res = (await env.AI.run(model as never, { text: [q] })) as { data?: number[][] };
          if (Array.isArray(res?.data) && res.data[0]) {
            qVec = res.data[0];
            await env.KV.put(qKey, JSON.stringify(qVec), { expirationTtl: 3600 }).catch(() => {});
          }
        }
      } catch {
        qVec = null;
      }
      if (qvecMem.size > 200) qvecMem.clear();
      qvecMem.set(qKey, qVec ?? []);
    }

    const decoded = new Map<string, number[] | null>();
    const vecOf = (r: MemoryEntryRow): number[] | null => {
      if (!r.vec) return null;
      if (!decoded.has(r.id)) decoded.set(r.id, decodeVec(r.vec));
      return decoded.get(r.id) ?? null;
    };

    const scored = rows.map((r) => {
      let score = 0;
      for (const g of bigrams(r.content)) if (qGrams.has(g)) score += 1;
      for (const t of r.tags) if (tagCtx.includes(t)) score += 3;
      for (const w of qWords) if (r.content.toLowerCase().includes(w)) score += 2;
      for (const a of aliases) if (r.content.toLowerCase().includes(a)) score += 2;
      if (qVec) {
        const rv = vecOf(r);
        if (rv) score += cosine(qVec, rv) * 3;
      }
      return { r, score };
    });

    const sorted = scored
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || (b.r.date ?? '').localeCompare(a.r.date ?? ''))
      .slice(0, k);

    let picked = sorted;
    if (picked.length === 0) {
      // 召回兜底：最近更新的几条（宁可有相关背景，也不能完全断片）
      picked = rows.slice(0, k).map((r) => ({ r, score: 0 }));
    }
    const lines = picked
      .map((x) => `- ${x.r.date ? `[${x.r.date}] ` : ''}${stripTags(x.r.content)}`)
      .filter(Boolean);
    if (lines.length === 0) return '';
    return ['## 相关记忆（按话题检索）', ...lines].join('\n');
  } catch (e) {
    console.warn('[memory-index] recall failed:', e);
    return '';
  }
}
