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
import { loadRollups } from './memory-rollups';
import { distillText } from './distill';

/** 永远常驻注入、不参与检索的分区（核心层）。 */
export const CORE_SECTIONS = ['人物底色', '称呼与关系', '雷区与禁忌'];

/** 各分区在召回里的重要度（越高越优先占 top-k 名额）。 */
export const SECTION_IMPORTANCE: Record<string, number> = {
  关于用户: 3,
  偏好与习惯: 3,
  进行中的事项: 3,
  共同经历: 2,
  近期动态: 1,
  档案: 2,
};

export function sectionImportance(section: string): number {
  return SECTION_IMPORTANCE[section] ?? 2;
}

/** 单次聊天注入的召回条数上限。 */
export const RECALL_TOP_K = 6;
/** 先粗召回多少条候选，再做重排。 */
export const CANDIDATE_TOP_K = 20;
/** MMR 去冗余惩罚系数（越大越优先多样性）。 */
const MMR_PENALTY = 6;

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
  /** 语义去重：指向"内容更详细"的主条目；值为 null 表示自己就是主条目 */
  dupOf: string | null;
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
        importance: sectionImportance(p.section),
        tags,
        keywords: [],
        vec: null,
        source: p.source,
        dupOf: null,
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

    // 语义去重（只发生在索引视图，不动本体）：同一分区里高度相似的条目，
    // 只让"内容更详细"的那条参与召回，其余指向它。
    {
      const groups = new Map<string, MemoryEntryRow[]>();
      for (const r of rows) {
        const list = groups.get(r.section) ?? [];
        list.push(r);
        groups.set(r.section, list);
      }
      for (const list of groups.values()) {
        list.sort((a, b) => b.content.length - a.content.length); // 长的优先当主条
        const primaries: MemoryEntryRow[] = [];
        for (const r of list) {
          const rv = r.vec ? decodeVec(r.vec) : null;
          let hit: MemoryEntryRow | null = null;
          if (rv) {
            for (const p of primaries) {
              const pv = p.vec ? decodeVec(p.vec) : null;
              if (!pv) continue;
              const bothTagged = p.tags.length > 0 && r.tags.length > 0;
              if (bothTagged && !p.tags.some((t) => r.tags.includes(t))) continue;
              if (cosine(rv, pv) >= 0.9) {
                hit = p;
                break;
              }
            }
          }
          if (hit) r.dupOf = hit.id;
          else primaries.push(r);
        }
      }
    }

    const stmt = env.DB.prepare(
      `INSERT OR REPLACE INTO memory_entries
       (id, section, content, date, importance, tags, keywords, vec, source, dup_of, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
            r.dupOf,
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
    'SELECT id, section, content, date, importance, tags, keywords, vec, source, dup_of FROM memory_entries ORDER BY updated_at DESC',
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
    dup_of: string | null;
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
    dupOf: r.dup_of ?? null,
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

/** 安全版字段缩写（只在注入视图生效，本体仍是完整键名）。 */
const ABBREV_KEYS: Array<[string, string]> = [
  ['城市', '城'],
  ['职业', '职'],
  ['喜好', '喜'],
  ['颜色', '色'],
  ['居住', '住'],
];

export function abbreviateKeys(text: string): string {
  let out = text;
  for (const [full, short] of ABBREV_KEYS) {
    out = out.split(`${full}=`).join(`${short}=`);
  }
  return out;
}

/** 长条目只注入「命中的子句」；没命中任何子句就截取开头（保留出处可回溯）。 */
export function clipMatchedClauses(
  content: string,
  qGrams: Set<string>,
  qWords: Set<string>,
  maxLen = 90,
): string {
  const text = stripTags(content);
  if (text.length <= 70) return text;
  const parts = text.split(/(?<=[。！？；!?;，,])/);
  const picked: string[] = [];
  for (const p of parts) {
    const g = bigrams(p).filter((x) => qGrams.has(x)).length;
    const w = [...qWords].filter((x) => p.toLowerCase().includes(x)).length;
    if (g + w > 0) picked.push(p);
  }
  if (picked.length === 0) return `${text.slice(0, maxLen)}…`;
  let out = '';
  for (const p of picked) {
    const next = out ? `${out}…${p}` : p;
    if (next.length > maxLen + 40) {
      out += '…';
      break;
    }
    out = next;
  }
  return out.replace(/…+$/g, '…');
}

function clauseFingerprint(s: string): string {
  return s
    .replace(/^-\s*\[[^\]]+\]\s*/, '')
    .toLowerCase()
    .replace(/[\s\u3000，。、；：！？,.;:!?"'“”‘’（）()【】\[\]]/g, '');
}

export function clauseFingerprints(text: string): Set<string> {
  const out = new Set<string>();
  for (const c of (text || '').split(/[。！？；!?;\n]/)) {
    const fp = clauseFingerprint(c);
    if (fp.length >= 8) out.add(fp);
  }
  return out;
}

/** 跨层去重：短期/中期已经带上的事实，从召回块里剔除（只删注入视图，不动本体）。 */
export function stripDuplicateRecall(recalled: string, seen: string[]): string {
  const seenSet = new Set<string>();
  for (const s of seen) for (const fp of clauseFingerprints(s)) seenSet.add(fp);
  const lines = (recalled || '').split('\n');
  const out: string[] = [];
  for (const line of lines) {
    if (!line.startsWith('- ')) {
      out.push(line);
      continue;
    }
    const kept = line
      .split(/[。！？；!?;\n]/)
      .map((c) => c.trim())
      .filter((c) => c && !seenSet.has(clauseFingerprint(c)));
    if (kept.length === 0) continue; // 全部重复 → 整条删掉（更近的层里有完整版）
    out.push(kept.join('…'));
  }
  return out.join('\n');
}

function bigramSet(text: string): Set<string> {
  return new Set(bigrams(text));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}

type Scored = { r: MemoryEntryRow; score: number };

/** MMR 重排：在分数之外惩罚“和已选条目太像”的候选，避免 6 条都在说同一件事。 */
export function mmrSelect(candidates: Scored[], k: number): Scored[] {
  const pool = candidates.slice();
  const sets = new Map<string, Set<string>>(pool.map((c) => [c.r.id, bigramSet(c.r.content)]));
  const selected: Scored[] = [];
  while (selected.length < k && pool.length > 0) {
    let bestIdx = 0;
    let bestVal = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const c = pool[i];
      const cs = sets.get(c.r.id) ?? new Set<string>();
      let maxSim = 0;
      for (const s of selected) {
        maxSim = Math.max(maxSim, jaccard(cs, sets.get(s.r.id) ?? new Set<string>()));
      }
      const val = c.score - MMR_PENALTY * maxSim;
      if (val > bestVal) {
        bestVal = val;
        bestIdx = i;
      }
    }
    selected.push(pool.splice(bestIdx, 1)[0]);
  }
  return selected;
}

/** 只有“低置信度/长消息/指代/候选接近”时才值得多调一次模型。 */
export function needsLlmRerank(query: string, pool: Scored[]): boolean {
  if (pool.length <= RECALL_TOP_K) return false;
  const q = (query || '').trim();
  if (q.length > 80) return true;
  if (/(那个|上次|之前|那件事|这事|它|他们)/.test(q)) return true;
  const top = pool[0]?.score ?? 0;
  const kth = pool[Math.min(RECALL_TOP_K, pool.length - 1)]?.score ?? 0;
  return top < 4 || top - kth < 1;
}

/** 条件触发的 LLM 二次筛选：只输出候选序号，失败一律回退确定性排序。 */
async function llmRerank(
  env: Env,
  query: string,
  pool: Scored[],
  k: number,
): Promise<Scored[] | null> {
  try {
    const lines = pool
      .map((c, i) => `${i + 1}. [${c.r.section}] ${c.r.content.slice(0, 120)}`)
      .join('\n');
    const system =
      '你是记忆检索重排器。只从候选里挑和用户这句话最相关的记忆，宁缺毋滥；' +
      '优先稳定事实、正在做的事、雷区；不要选只靠一个泛词碰上的无关条目。' +
      '只输出 JSON 数组，例如 [1,4,7]，不要解释。';
    const user = `用户消息：${query}\n\n候选：\n${lines}\n\n最多选 ${k} 条，输出序号数组。`;
    const res = await distillText(
      env,
      system,
      user,
      120,
      env.SUMMARY_DEEPSEEK_MODEL || env.DEEPSEEK_MODEL,
    );
    const nums = [...res.text.matchAll(/\d+/g)]
      .map((m) => Number(m[0]))
      .filter((n, i, arr) => n >= 1 && n <= pool.length && arr.indexOf(n) === i)
      .slice(0, k);
    if (nums.length === 0) return null;
    return nums.map((n) => pool[n - 1]);
  } catch (e) {
    console.warn('[memory-index] llm rerank failed, fallback deterministic:', e);
    return null;
  }
}

/** 保证“进行中的事项”至少有一条进注入（它的重要度是 3，不能被挤掉）。 */
function ensureOngoing(selected: Scored[], pool: Scored[], k: number): Scored[] {
  const ongoing = pool.find((c) => c.r.section === '进行中的事项' && c.score > 0);
  if (!ongoing || selected.some((c) => c.r.id === ongoing.r.id)) return selected;
  if (selected.length < k) return [...selected, ongoing];
  let worst = 0;
  for (let i = 1; i < selected.length; i++) {
    if (selected[i].score < selected[worst].score) worst = i;
  }
  const next = selected.slice();
  next[worst] = ongoing;
  return next;
}

/** 按当前话题召回 top-k 条记忆（双路打分，无命中回退最近条目）。 */
export async function recallMemoryForChat(
  env: Env,
  query: string,
  k = RECALL_TOP_K,
  focus = '',
): Promise<string> {
  const q = (query || '').slice(-1000).trim();
  if (!q) return '';
  try {
    const rows = (await loadRows(env)).filter((r) => !r.dupOf);
    if (rows.length === 0) return '';

    const qGrams = new Set(bigrams(q));
    const qWords = new Set(strongWords(q).filter((w) => w.length >= 3));
    const aliases = new Set(aliasTerms(q));
    const tagCtx = expandQuery(q).toLowerCase();
    const focusWords = new Set(strongWords(focus).filter((w) => w.length >= 3));

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

    // 时间金字塔：60 天前权重减半、90 天前再降一档，让周/月摘要接管常规召回
    const bjNow = new Date(Date.now() + 8 * 3600 * 1000);
    const fmt = (ms: number) => {
      const d = new Date(ms);
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    };
    const cutoff60 = fmt(bjNow.getTime() - 60 * 86400000);
    const cutoff90 = fmt(bjNow.getTime() - 90 * 86400000);

    const scored = rows.map((r) => {
      let score = 0;
      for (const g of bigrams(r.content)) if (qGrams.has(g)) score += 1;
      for (const t of r.tags) if (tagCtx.includes(t)) score += 3;
      for (const w of qWords) if (r.content.toLowerCase().includes(w)) score += 2;
      for (const a of aliases) if (r.content.toLowerCase().includes(a)) score += 2;
      for (const w of focusWords) if (r.content.toLowerCase().includes(w)) score += 2;
      if (qVec) {
        const rv = vecOf(r);
        if (rv) score += cosine(qVec, rv) * 3;
      }
      // ★ 重要度只在“确实相关”时加分：不能只靠 importance 让无关条目进候选池，
      //   否则每轮都有 20 条候选、top 分数又接近，会频繁触发 LLM 重排拖慢回复。
      if (score > 0) score += r.importance;
      if (r.date && r.date < cutoff90) score *= 0.25;
      else if (r.date && r.date < cutoff60) score *= 0.5;
      return { r, score };
    });

    // 粗召回 20 条候选 → MMR 去冗余 → 条件 LLM 重排 → 强保“进行中的事项”
    const pool = scored
      .filter((x) => x.score > 0)
      .sort(
        (a, b) =>
          b.score - a.score ||
          b.r.importance - a.r.importance ||
          (b.r.date ?? '').localeCompare(a.r.date ?? ''),
      )
      .slice(0, CANDIDATE_TOP_K);

    let picked = pool.slice(0, k);
    if (pool.length > k) picked = mmrSelect(pool, k);
    // LLM 重排默认开启；设置 LLM_RERANK=0 可关闭（只影响“选哪几条”，不动记忆本体）
    if (env.LLM_RERANK !== '0' && needsLlmRerank(q, pool)) {
      const t0 = Date.now();
      const llm = await llmRerank(env, q, pool, k);
      if (llm && llm.length > 0) picked = llm;
      console.log(
        `[recall] llm rerank q="${q.slice(0, 30)}" pool=${pool.length} top=${pool[0]?.score ?? 0} ms=${Date.now() - t0} picked=${picked.length}`,
      );
    }
    picked = ensureOngoing(picked, pool, k);
    if (picked.length === 0) {
      // 召回兜底：最近更新的几条（宁可有相关背景，也不能完全断片）
      picked = rows.slice(0, k).map((r) => ({ r, score: 0 }));
    }
    const lines = picked
      .map((x) => {
        const body = abbreviateKeys(clipMatchedClauses(stripTags(x.r.content), qGrams, qWords));
        return `- ${x.r.date ? `[${x.r.date}] ` : ''}${body}`;
      })
      .filter(Boolean);

    // 周/月摘要也参与召回（关键词命中即注入，最多 2 条），让老记忆用更少字被想起
    try {
      const rollups = await loadRollups(env);
      const rScored = rollups
        .map((r) => {
          let score = 0;
          for (const g of bigrams(r.content)) if (qGrams.has(g)) score += 1;
          for (const w of qWords) if (r.content.toLowerCase().includes(w)) score += 2;
          for (const a of aliases) if (r.content.toLowerCase().includes(a)) score += 2;
          return { r, score };
        })
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score || b.r.period.localeCompare(a.r.period))
        .slice(0, 2);
      for (const x of rScored) {
        lines.push(`- 【${x.r.level === 'week' ? '周' : '月'}摘要】${stripTags(x.r.content)}`);
      }
    } catch {
      /* 摘要加载失败不影响条目召回 */
    }

    if (lines.length === 0) return '';
    return ['## 相关记忆（按话题检索）', ...lines].join('\n');
  } catch (e) {
    console.warn('[memory-index] recall failed:', e);
    return '';
  }
}
