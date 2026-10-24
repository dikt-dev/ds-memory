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

const CORE_SECTIONS = new Set(['人物底色', '称呼与关系', '雷区与禁忌']);
const EVENT_SECTIONS = new Set(['共同经历', '近期动态']);
const RELATION_LINE_RE = /^(好感度|亲密度|心情值?|信任|尊重|心动)\s*[:：]/;
const ENTRY_RE = /^-\s*\[((?:\d{4}|\d{2})-\d{2}-\d{2})\]\s*(.+)$/;

export const MEMORY_SECTION_ORDER = [
  '人物底色',
  '称呼与关系',
  '关于用户',
  '偏好与习惯',
  '进行中的事项',
  '共同经历',
  '雷区与禁忌',
  '近期动态',
] as const;

const IMPORTANCE: Record<string, number> = {
  关于用户: 3,
  偏好与习惯: 3,
  进行中的事项: 3,
  共同经历: 2,
  近期动态: 1,
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
    const em = raw.trim().match(ENTRY_RE);
    if (!em) continue;
    const date = normalizeDate(em[1]);
    const content = em[2].trim();
    if (!content || RELATION_LINE_RE.test(content)) continue;
    const tags = autoTags(content, 3);
    const kv = parseKeyValue(content);
    const contentHash = stableHash(content);
    if (EVENT_SECTIONS.has(section)) {
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

/** 关键词/标签/同义词排序（Phase 4 再接向量与 RRF）。 */
export function rankMemoryChunks(
  query: string,
  chunks: MemoryChunk[],
  k = 6,
  focus = '',
): MemoryChunk[] {
  const q = (query || '').slice(-1000).trim();
  if (!q || chunks.length === 0) return [];
  const qGrams = new Set(bigrams(q));
  const qWords = new Set(strongWords(q).filter((w) => w.length >= 3));
  const aliases = new Set(aliasTerms(q));
  const focusWords = new Set(strongWords(focus).filter((w) => w.length >= 3));
  const oldCutoff = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);
  const scored = chunks.map((chunk) => {
    let score = 0;
    for (const g of chunk.keywords) if (qGrams.has(g)) score += 1;
    for (const g of bigrams(chunk.content)) if (qGrams.has(g)) score += 1;
    for (const t of chunk.tags) if (q.toLowerCase().includes(t)) score += 3;
    for (const w of qWords) if (chunk.content.toLowerCase().includes(w)) score += 2;
    for (const a of aliases) if (chunk.content.toLowerCase().includes(a)) score += 2;
    for (const w of focusWords) if (chunk.content.toLowerCase().includes(w)) score += 2;
    if (score > 0) score += chunk.importance;
    if (chunk.date && chunk.date < oldCutoff) score *= 0.5;
    return { chunk, score };
  });
  return scored
    .filter((x) => x.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.chunk.importance - a.chunk.importance ||
        dateOfChunk(b.chunk).localeCompare(dateOfChunk(a.chunk)),
    )
    .slice(0, Math.max(1, k))
    .map((x) => x.chunk);
}

export function formatMemoryChunks(chunks: MemoryChunk[]): string {
  if (chunks.length === 0) return '';
  return [
    '## 相关记忆（Memory Context）',
    ...chunks.map((c) => `- ${c.date ? `[${c.date}] ` : ''}${c.content}`),
  ].join('\n');
}
