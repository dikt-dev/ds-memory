/**
 * Memory Context 领域模型（Phase 2）。
 *
 * 目标：把 memory.md 的“行”提升为可操作的事实/事件/chunk，
 * 并提供纯函数：
 * - 解析 memory.md → facts / events；
 * - 投影回 memory.md（保留人工 pinned 区）；
 * - 关键词排序（Phase 4 再加向量/RRF）。
 *
 * 本文件不依赖 Cloudflare API，便于单测与回放。
 */
import { aliasTerms, autoTags, bigrams, strongWords } from './memory-archive';
import { cosineSimilarity, decodeVec } from './memory-index';

export type MemoryChunkSource = 'fact' | 'event' | 'summary';
export type MemorySummaryLevel = 'day' | 'week' | 'month';

export interface MemoryFact {
  id: string;
  section: string;
  content: string;
  subject: string | null;
  predicate: string | null;
  object: string | null;
  validFrom: string | null;
  validTo: string | null;
  confidence: number;
  sourceMessageIds: number[];
  tags: string[];
  contentHash: string;
  createdAt: number;
  updatedAt: number;
}

export interface MemoryEvent {
  id: string;
  section: string;
  dateKey: string;
  summary: string;
  participants: string;
  emotions: string;
  sourceMessageIds: number[];
  contentHash: string;
  createdAt: number;
}

export interface MemorySummary {
  id: string;
  level: MemorySummaryLevel;
  period: string;
  content: string;
  sourceIds: string[];
  createdAt: number;
}

export interface MemoryChunk {
  id: string;
  source: MemoryChunkSource;
  sourceId: string;
  section: string;
  content: string;
  date: string | null;
  keywords: string[];
  tags: string[];
  importance: number;
  contentHash: string;
  updatedAt: number;
  vec?: string | null;
}

export interface ParsedMemoryContext {
  facts: MemoryFact[];
  events: MemoryEvent[];
}

const CORE_SECTIONS = new Set([
  '用户更正（最高优先级）',
  '人物底色',
  '称呼与关系',
  '雷区与禁忌',
]);
const EVENT_SECTIONS = new Set(['共同经历', '近期动态']);
const RELATION_LINE_RE = /^(好感度|亲密度|心情值?|信任|尊重|心动)\s*[:：]/;
const ENTRY_RE = /^-\s*\[((?:\d{4}|\d{2})-\d{2}-\d{2})\]\s*(.+)$/;

export const MEMORY_SECTION_ORDER = [
  '用户更正（最高优先级）',
  '人物底色',
  '称呼与关系',
  '关于用户',
  '偏好与习惯',
  '进行中的事项',
  '共同经历',
  '雷区与禁忌',
  '近期动态',
] as const;

const QUERY_STOP_CHARS = new Set('我的你他她它这那有是个了吗呢吧啊什么怎为在就和与及或把被让给对从到又还都也一不没天吃今'.split(''));

const IMPORTANCE: Record<string, number> = {
  关于用户: 3,
  偏好与习惯: 3,
  进行中的事项: 3,
  共同经历: 2,
  近期动态: 1,
  档案: 1,
  雷区与禁忌: 3,
};

/** FNV-1a 稳定短 hash：用于派生 id/content_hash，不用于安全。 */
export function stableHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function normalizeDate(date: string): string {
  const [y, m, d] = date.split('-');
  if (!y || !m || !d) return date;
  return y.length === 2 ? `20${y}-${m}-${d}` : `${y}-${m}-${d}`;
}

export function compactDate(date: string): string {
  const full = normalizeDate(date);
  return full.length === 10 ? full.slice(2) : full;
}

export function factId(section: string, date: string | null, content: string): string {
  return `fact_${stableHash(`${section}|${date ?? ''}|${content}`)}`;
}

export function eventId(section: string, date: string, content: string): string {
  return `event_${stableHash(`${section}|${date}|${content}`)}`;
}

function parseKeyValue(content: string): { key: string; value: string } | null {
  const m = content.match(/^([^=＝\n]{1,16})[=＝]\s*(.+)$/);
  if (!m) return null;
  return { key: m[1].trim(), value: m[2].trim() };
}

/**
 * 解析 memory.md：核心区不进入 facts/events（仍由 pinned 注入），
 * 事件区进入 events，其余进入 facts。
 */
export function parseMemoryContext(text: string, now = Date.now()): ParsedMemoryContext {
  const facts: MemoryFact[] = [];
  const events: MemoryEvent[] = [];
  let section = '';
  for (const raw of text.split('\n')) {
    const header = raw.match(/^##\s+(.*)$/);
    if (header) {
      section = header[1].trim();
      continue;
    }
    if (!section || CORE_SECTIONS.has(section)) continue;
    const line = raw.trim();
    if (!line.startsWith('-')) continue;
    const em = line.match(ENTRY_RE);
    const date = em ? normalizeDate(em[1]) : null;
    const content = (em ? em[2] : line.replace(/^-\s*/, '')).trim();
    if (!content || RELATION_LINE_RE.test(content)) continue;
    const tags = autoTags(content, 3);
    const kv = parseKeyValue(content);
    const contentHash = stableHash(content);
    if (EVENT_SECTIONS.has(section)) {
      // 事件必须有日期；无日期条目只作为普通事实进入，避免伪造事件时间。
      if (!date) continue;
      events.push({
        id: eventId(section, date, content),
        section,
        dateKey: date,
        summary: content,
        participants: '',
        emotions: '',
        sourceMessageIds: [],
        contentHash,
        createdAt: now,
      });
    } else {
      facts.push({
        id: factId(section, date, content),
        section,
        content,
        subject: kv ? kv.key : null,
        predicate: kv ? kv.key : null,
        object: kv ? kv.value : null,
        validFrom: date,
        validTo: null,
        confidence: 1,
        sourceMessageIds: [],
        tags,
        contentHash,
        createdAt: now,
        updatedAt: now,
      });
    }
  }
  return { facts, events };
}

/** 事实在 atDate（YYYY-MM-DD）是否有效。 */
export function isFactActive(fact: MemoryFact, atDate: string): boolean {
  if (fact.validFrom && fact.validFrom > atDate) return false;
  if (fact.validTo && fact.validTo <= atDate) return false;
  return true;
}

/** 合并来源 ID（去重、稳定排序）。 */
function mergeIds(a: number[], b: number[]): number[] {
  return [...new Set([...a, ...b])].sort((x, y) => x - y);
}

/**
 * 过滤过期事实，并按「section + subject/predicate」或 contentHash 去重。
 * 同一槽位保留 validFrom 更新的一条；来源 ID 合并，避免冲突时丢证据。
 */
export function canonicalizeFacts(facts: MemoryFact[], atDate: string): MemoryFact[] {
  const byKey = new Map<string, MemoryFact>();
  for (const original of facts) {
    if (!isFactActive(original, atDate)) continue;
    const fact: MemoryFact = { ...original, sourceMessageIds: [...original.sourceMessageIds] };
    const slot = fact.predicate
      ? `${fact.section}|${fact.subject ?? ''}|${fact.predicate}`
      : `${fact.section}|${fact.contentHash}`;
    const prev = byKey.get(slot);
    if (!prev) {
      byKey.set(slot, fact);
      continue;
    }
    const prevDate = prev.validFrom ?? '';
    const nextDate = fact.validFrom ?? '';
    if (nextDate >= prevDate) {
      fact.sourceMessageIds = mergeIds(prev.sourceMessageIds, fact.sourceMessageIds);
      byKey.set(slot, fact);
    } else {
      prev.sourceMessageIds = mergeIds(prev.sourceMessageIds, fact.sourceMessageIds);
    }
  }
  return [...byKey.values()];
}

/** 把 archive.md 的行（`- [date] content`）解析成事件；不进入 memory.md 投影。 */
export function parseArchiveContext(lines: string[], now = Date.now()): MemoryEvent[] {
  const out: MemoryEvent[] = [];
  for (const line of lines) {
    const em = line.trim().match(ENTRY_RE);
    if (!em) continue;
    const date = normalizeDate(em[1]);
    const summary = em[2].trim();
    if (!summary) continue;
    out.push({
      id: eventId('档案', date, summary),
      section: '档案',
      dateKey: date,
      summary,
      participants: '',
      emotions: '',
      sourceMessageIds: [],
      contentHash: stableHash(summary),
      createdAt: now,
    });
  }
  return out;
}

export function buildMemoryChunks(parsed: ParsedMemoryContext, now = Date.now()): MemoryChunk[] {
  const chunks: MemoryChunk[] = [];
  for (const fact of parsed.facts) {
    chunks.push({
      id: `chunk_${fact.id}`,
      source: 'fact',
      sourceId: fact.id,
      section: fact.section,
      content: fact.content,
      date: fact.validFrom,
      keywords: bigrams(fact.content).slice(0, 24),
      tags: fact.tags,
      importance: IMPORTANCE[fact.section] ?? 2,
      contentHash: fact.contentHash,
      updatedAt: now,
    });
  }
  for (const event of parsed.events) {
    chunks.push({
      id: `chunk_${event.id}`,
      source: 'event',
      sourceId: event.id,
      section: event.section,
      content: event.summary,
      date: event.dateKey,
      keywords: bigrams(event.summary).slice(0, 24),
      tags: autoTags(event.summary, 3),
      importance: IMPORTANCE[event.section] ?? 2,
      contentHash: event.contentHash,
      updatedAt: now,
    });
  }
  return chunks;
}

/** 从 pinned 文本里抽出核心分区（保留原文）。 */
function extractPinnedSections(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let current = '';
  const lines: string[] = [];
  const flush = () => {
    if (current && lines.length > 0) out.set(`## ${current}`, lines.join('\n').trimEnd());
  };
  for (const line of text.split('\n')) {
    const m = line.match(/^##\s+(.*)$/);
    if (m) {
      flush();
      current = m[1].trim();
      lines.length = 0;
      lines.push(line);
      continue;
    }
    if (current) lines.push(line);
  }
  flush();
  return out;
}

function dateOfChunk(chunk: MemoryChunk): string {
  return chunk.date ?? '9999-99-99';
}

/**
 * 由 facts/events 投影回 memory.md。
 * 核心分区（人物底色/称呼与关系/雷区与禁忌）从 pinned 原文保留，
 * 其余分区按日期排序重建；没有条目时保留空标题，便于人工继续添加。
 */
export function projectMemoryContext(pinnedText: string, parsed: ParsedMemoryContext): string {
  const pinned = extractPinnedSections(pinnedText);
  const factsBySection = new Map<string, MemoryFact[]>();
  for (const f of parsed.facts) {
    const list = factsBySection.get(f.section) ?? [];
    list.push(f);
    factsBySection.set(f.section, list);
  }
  const eventsBySection = new Map<string, MemoryEvent[]>();
  for (const e of parsed.events) {
    const list = eventsBySection.get(e.section) ?? [];
    list.push(e);
    eventsBySection.set(e.section, list);
  }

  const parts: string[] = ['# 长期记忆', '', '> 由 Memory Context 投影生成；核心分区保留人工内容。', ''];
  for (const name of MEMORY_SECTION_ORDER) {
    if (CORE_SECTIONS.has(name)) {
      const block = pinned.get(`## ${name}`) ?? `## ${name}`;
      parts.push(block, '');
      continue;
    }
    const lines: Array<{ date: string; text: string }> = [];
    for (const f of factsBySection.get(name) ?? []) {
      lines.push({ date: f.validFrom ?? '', text: f.content });
    }
    for (const e of eventsBySection.get(name) ?? []) {
      lines.push({ date: e.dateKey, text: e.summary });
    }
    lines.sort((a, b) => a.date.localeCompare(b.date) || a.text.localeCompare(b.text));
    parts.push(`## ${name}`);
    for (const line of lines) {
      parts.push(`- [${compactDate(line.date)}] ${line.text}`);
    }
    parts.push('');
  }
  return parts.join('\n').trim() + '\n';
}

export interface RankOptions {
  /** 查询向量；为空或没有 chunk 向量时自动退回关键词。 */
  queryVec?: number[] | null;
  /** MMR 多样性系数，0=纯分数，1=强去冗余。 */
  mmrLambda?: number;
}

interface ScoredChunk {
  chunk: MemoryChunk;
  score: number;
}

function keywordScore(q: string, chunk: MemoryChunk, focus: string): number {
  const qGrams = new Set(bigrams(q));
  const qWords = new Set(strongWords(q).filter((w) => w.length >= 3));
  const aliases = new Set(aliasTerms(q));
  const focusWords = new Set(strongWords(focus).filter((w) => w.length >= 3));
  // 中文单字兜底：bigram 覆盖不到「猫」这类单字实体。
  const qChars = [...new Set(q)].filter(
    (c) => /[\u4e00-\u9fff]/.test(c) && !QUERY_STOP_CHARS.has(c),
  );
  let score = 0;
  for (const g of chunk.keywords) if (qGrams.has(g)) score += 1;
  for (const g of bigrams(chunk.content)) if (qGrams.has(g)) score += 1;
  for (const t of chunk.tags) if (q.toLowerCase().includes(t)) score += 3;
  for (const w of qWords) if (chunk.content.toLowerCase().includes(w)) score += 2;
  for (const a of aliases) if (chunk.content.toLowerCase().includes(a)) score += 2;
  for (const w of focusWords) if (chunk.content.toLowerCase().includes(w)) score += 2;
  for (const c of qChars) if (chunk.content.includes(c)) score += 1;
  if (score > 0) score += chunk.importance;
  const oldCutoff = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);
  if (chunk.date && chunk.date < oldCutoff) score *= 0.5;
  return score;
}

function chunkSimilarity(a: MemoryChunk, b: MemoryChunk): number {
  const av = decodeVec(a.vec ?? null);
  const bv = decodeVec(b.vec ?? null);
  if (av && bv) return Math.max(0, cosineSimilarity(av, bv));
  // 没有向量时用内容 bigram Jaccard 做去冗余兜底
  const as = new Set(bigrams(a.content));
  const bs = new Set(bigrams(b.content));
  if (as.size === 0 || bs.size === 0) return 0;
  let inter = 0;
  for (const g of as) if (bs.has(g)) inter += 1;
  return inter / Math.max(as.size, bs.size);
}

/** MMR：先取最高分，再逐步惩罚与已选条目相似的候选。 */
export function mmrSelectChunks(
  candidates: ScoredChunk[],
  k: number,
  lambda = 0.75,
): MemoryChunk[] {
  if (k <= 0 || candidates.length === 0) return [];
  // 防止调用方传入未截断大池时退化成 O(n²)。
  const pool = [...candidates]
    .sort((a, b) => b.score - a.score)
    .slice(0, 50);
  const maxScore = Math.max(1, pool[0]?.score ?? 1);
  const selected: ScoredChunk[] = [];
  while (selected.length < k && pool.length > 0) {
    let bestIdx = 0;
    let bestVal = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      let maxSim = 0;
      for (const chosen of selected) {
        maxSim = Math.max(maxSim, chunkSimilarity(pool[i].chunk, chosen.chunk));
      }
      // 归一化惩罚，避免不同 query 的绝对分数尺度影响多样性
      const val = pool[i].score - (1 - lambda) * maxSim * maxScore;
      if (val > bestVal) {
        bestVal = val;
        bestIdx = i;
      }
    }
    selected.push(pool.splice(bestIdx, 1)[0]);
  }
  return selected.map((x) => x.chunk);
}

const GREETING_RE = /^(你好|在吗|早安|晚安|哈哈|嘿嘿|谢谢|好的|嗯+|哦+|ok|hi|hello|在不在)[!！。,.，\s]*$/i;
const TECH_RE = /^(帮我|写|解释|翻译|计算|生成|做个|怎么|code|写个)/i;
const MEMORY_MARK_RE = /(上次|之前|以前|记得|我说过|那次|昨天|前天|还记得|我说|曾经)/;

/**
 * Query 规划：明显是寒暄/纯技术请求时不触发个人记忆检索。
 * 有“上次/之前/记得”等记忆标记时始终触发。
 */
export function shouldRecallMemory(query: string): boolean {
  const q = (query ?? '').trim();
  if (!q) return false;
  if (MEMORY_MARK_RE.test(q)) return true;
  if (GREETING_RE.test(q)) return false;
  if (TECH_RE.test(q)) return false;
  return q.length >= 3;
}

/**
 * 关键词 + 向量混合召回（Phase 4）：
 * - 两路各自排序，用 RRF 融合；
 * - 有向量时 MMR 去冗余；无向量自动退回关键词；
 * - 纯函数，便于 golden set / 延迟测试。
 */
export function rankMemoryChunks(
  query: string,
  chunks: MemoryChunk[],
  k = 6,
  focus = '',
  options: RankOptions = {},
): MemoryChunk[] {
  const q = (query || '').slice(-1000).trim();
  if (!q || chunks.length === 0) return [];
  const scored = chunks
    .map((chunk) => ({ chunk, score: keywordScore(q, chunk, focus) }))
    .filter((x) => x.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.chunk.importance - a.chunk.importance ||
        dateOfChunk(b.chunk).localeCompare(dateOfChunk(a.chunk)),
    );

  const qVec = options.queryVec;
  const hasVectors = chunks.some((c) => Boolean(c.vec));
  if (!qVec || !hasVectors) {
    return mmrSelectChunks(scored, Math.max(1, k), options.mmrLambda ?? 0.9);
  }

  const vectorRanked = chunks
    .map((chunk) => {
      const vec = decodeVec(chunk.vec ?? null);
      return { chunk, score: vec ? Math.max(0, cosineSimilarity(qVec, vec)) : 0 };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  if (vectorRanked.length === 0) {
    return mmrSelectChunks(scored, Math.max(1, k), options.mmrLambda ?? 0.9);
  }

  const RRF_K = 60;
  const fused = new Map<string, ScoredChunk>();
  const add = (chunk: MemoryChunk, rank: number) => {
    const cur = fused.get(chunk.id) ?? { chunk, score: 0 };
    cur.score += 1 / (RRF_K + rank + 1);
    fused.set(chunk.id, cur);
  };
  scored.slice(0, 30).forEach((x, i) => add(x.chunk, i));
  vectorRanked.slice(0, 30).forEach((x, i) => add(x.chunk, i));
  const merged = [...fused.values()].sort((a, b) => b.score - a.score);
  return mmrSelectChunks(merged, Math.max(1, k), options.mmrLambda ?? 0.75);
}

export function formatMemoryChunks(chunks: MemoryChunk[]): string {
  if (chunks.length === 0) return '';
  return [
    '## 相关记忆（Memory Context）',
    ...chunks.map((c) => `- ${c.date ? `[${c.date}] ` : ''}${c.content}`),
  ].join('\n');
}
