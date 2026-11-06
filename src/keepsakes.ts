/**
 * 铭记（keepsake）：比普通长期记忆更高一级的事实。
 *
 * 与 memory_chunks 的区别：
 * - 不进召回排序，常驻注入（30 条以内，1.5~2 KB）；
 * - 不参与合并、压缩、遗忘；只能停止注入（pinned=0）；
 * - 带 tone：好事、事实、伤过的事都算，但负向的只存事实，情绪仍归 grievance 管。
 *
 * 设计见 docs/memory/memory-milestones.md 与 keepsake-implementation.md。
 */
import type { Env } from './types';
import { distillText } from './distill';
import { addLlmCost } from './llm-cost';
import { dateKeyInBeijing } from './date';

export const KEEPSAKE_KINDS = [
  'first_meet',
  'name',
  'promise',
  'milestone',
  'custom',
  'first_fight',
  'hurt',
  'parting',
  'betrayal',
  'first_apology',
] as const;
export type KeepsakeKind = (typeof KEEPSAKE_KINDS)[number];

/** 自带负向的 kind：模型标错时以 kind 为准。 */
const BITTER_KINDS: KeepsakeKind[] = ['first_fight', 'hurt', 'parting', 'betrayal'];

export const KEEPSAKE_TONES = ['warm', 'neutral', 'bitter'] as const;
export type KeepsakeTone = (typeof KEEPSAKE_TONES)[number];

export type KeepsakeStatus = 'pending' | 'approved' | 'rejected';

export interface Keepsake {
  id: string;
  kind: KeepsakeKind;
  tone: KeepsakeTone;
  title: string;
  detail: string;
  happened_at: number;
  source: 'manual' | 'rule' | 'ai';
  evidence: string;
  status: KeepsakeStatus;
  pinned: number;
  created_at: number;
}

export interface NewKeepsake {
  kind: KeepsakeKind;
  tone?: KeepsakeTone;
  title: string;
  detail?: string;
  happened_at: number;
  source: 'manual' | 'rule' | 'ai';
  evidence?: string;
  status?: KeepsakeStatus;
}

export const KEEPSAKE_MAX = 120;
export const KEEPSAKE_MAX_BITTER = 32;
export const KEEPSAKE_MAX_DAILY_AI = 4;
export const KEEPSAKE_MAX_WEEKLY_AI = 10;
export const KEEPSAKE_MAX_DAILY_BITTER = 2;
export const KEEPSAKE_MAX_WEEKLY_BITTER = 4;
export const KEEPSAKE_BLOCK_KEY = 'keepsakes:block';
export const KEEPSAKE_ENABLED_KEY = 'keepsakes:enabled';

let ensured = false;

export async function ensureKeepsakesTable(env: Env): Promise<void> {
  if (ensured) return;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS memory_keepsakes (
       id TEXT PRIMARY KEY,
       kind TEXT NOT NULL,
       tone TEXT NOT NULL DEFAULT 'warm',
       title TEXT NOT NULL,
       detail TEXT NOT NULL DEFAULT '',
       happened_at INTEGER NOT NULL,
       source TEXT NOT NULL,
       evidence TEXT NOT NULL DEFAULT '',
       status TEXT NOT NULL DEFAULT 'pending',
       pinned INTEGER NOT NULL DEFAULT 1,
       title_key TEXT NOT NULL,
       created_at INTEGER NOT NULL
     )`,
  ).run();
  await env.DB.prepare(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_keepsakes_title_key ON memory_keepsakes(title_key)`,
  ).run();
  await env.DB.prepare(
    `CREATE INDEX IF NOT EXISTS idx_keepsakes_status ON memory_keepsakes(status, happened_at)`,
  ).run();
  ensured = true;
}

/** 标题归一化：去标点空格、统一小写，用于去重。 */
export function titleKey(title: string): string {
  return (title ?? '')
    .toLowerCase()
    .replace(/[\s，。！？、；："''（）()【】\[\]…—\-·,.!?;:]/g, '');
}

/** 字符二元组 Jaccard：用来识别「同一件事换了个说法」。 */
export function titleSimilarity(a: string, b: string): number {
  const grams = (s: string) => {
    const out = new Set<string>();
    for (let i = 0; i < s.length - 1; i += 1) out.add(s.slice(i, i + 2));
    return out;
  };
  const A = grams(a);
  const B = grams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let hit = 0;
  for (const g of A) if (B.has(g)) hit += 1;
  return hit / (A.size + B.size - hit);
}
interface KeepsakeRow {
  id: string;
  kind: string;
  tone: string;
  title: string;
  detail: string;
  happened_at: number;
  source: string;
  evidence: string;
  status: string;
  pinned: number;
  created_at: number;
}

function toKeepsake(row: KeepsakeRow): Keepsake {
  return {
    id: row.id,
    kind: row.kind as KeepsakeKind,
    tone: row.tone as KeepsakeTone,
    title: row.title,
    detail: row.detail,
    happened_at: row.happened_at,
    source: row.source as Keepsake['source'],
    evidence: row.evidence,
    status: row.status as KeepsakeStatus,
    pinned: row.pinned,
    created_at: row.created_at,
  };
}

export async function loadKeepsakes(env: Env, status?: KeepsakeStatus): Promise<Keepsake[]> {
  await ensureKeepsakesTable(env);
  const sql = status
    ? 'SELECT * FROM memory_keepsakes WHERE status = ? ORDER BY happened_at ASC'
    : 'SELECT * FROM memory_keepsakes ORDER BY happened_at ASC';
  const stmt = status ? env.DB.prepare(sql).bind(status) : env.DB.prepare(sql);
  const res = await stmt.all<KeepsakeRow>();
  return (res.results ?? []).map(toKeepsake);
}

function clip(text: string, max: number): string {
  const t = (text ?? '').trim().replace(/\s+/g, ' ');
  return t.length <= max ? t : t.slice(0, max);
}

/** 校验单条候选；不合格返回 null（不抛异常，便于批量丢弃）。 */
export function validateKeepsake(input: NewKeepsake, conversation = ''): NewKeepsake | null {
  if (!(KEEPSAKE_KINDS as readonly string[]).includes(input.kind)) return null;
  const title = clip(input.title, 24);
  if (!title) return null;
  const detail = clip(input.detail ?? '', 80);
  let tone: KeepsakeTone = (KEEPSAKE_TONES as readonly string[]).includes(input.tone ?? '')
    ? (input.tone as KeepsakeTone)
    : 'neutral';
  if (BITTER_KINDS.includes(input.kind)) tone = 'bitter';
  // 红线：引文必须是当天对话里原样存在的一段
  const rawEvidence = (input.evidence ?? '').trim();
  const evidence = rawEvidence && conversation.includes(rawEvidence) ? clip(rawEvidence, 80) : '';
  if (input.source === 'ai' && rawEvidence && !evidence) return null;
  return {
    ...input,
    title,
    detail,
    tone,
    evidence,
  };
}

function dayStartMs(now: number): number {
  const bj = new Date(now + 8 * 3600_000);
  const start = Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate()) - 8 * 3600_000;
  return start;
}

export type InsertOutcome = 'inserted' | 'duplicate' | 'dropped';

export async function insertKeepsake(
  env: Env,
  input: NewKeepsake,
  conversation = '',
  now = Date.now(),
): Promise<InsertOutcome> {
  await ensureKeepsakesTable(env);
  const clean = validateKeepsake(input, conversation);
  if (!clean) return 'dropped';

  const existing = await loadKeepsakes(env);
  const key = titleKey(clean.title);
  if (existing.some((k) => titleKey(k.title) === key)) return 'duplicate';
  if (existing.some((k) => titleSimilarity(titleKey(k.title), key) >= 0.8)) return 'duplicate';

  if (clean.source === 'ai') {
    const dayAgo = dayStartMs(now);
    const today = existing.filter((k) => k.source === 'ai' && k.created_at >= dayAgo);
    if (today.length >= KEEPSAKE_MAX_DAILY_AI) return 'dropped';
    if (existing.filter((k) => k.source === 'ai' && k.created_at >= now - 7 * 86400_000).length >= KEEPSAKE_MAX_WEEKLY_AI) return 'dropped';
    if (clean.tone === 'bitter') {
      const bitterToday = today.filter((k) => k.tone === 'bitter');
      if (bitterToday.length >= KEEPSAKE_MAX_DAILY_BITTER) return 'dropped';
      const bitterWeek = existing.filter(
        (k) => k.tone === 'bitter' && k.source === 'ai' && k.created_at >= now - 7 * 86400_000,
      );
      if (bitterWeek.length >= KEEPSAKE_MAX_WEEKLY_BITTER) return 'dropped';
    }
  }

  await env.DB.prepare(
    `INSERT OR IGNORE INTO memory_keepsakes
       (id, kind, tone, title, detail, happened_at, source, evidence, status, pinned, title_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      `k_${now}_${Math.random().toString(36).slice(2, 8)}`,
      clean.kind,
      clean.tone,
      clean.title,
      clean.detail ?? '',
      clean.happened_at,
      clean.source,
      clean.evidence ?? '',
      clean.status ?? (clean.source === 'ai' ? 'pending' : 'approved'),
      1,
      key,
      now,
    )
    .run();
  return 'inserted';
}

export async function setKeepsakeStatus(
  env: Env,
  id: string,
  status: KeepsakeStatus,
): Promise<boolean> {
  await ensureKeepsakesTable(env);
  const res = await env.DB.prepare('UPDATE memory_keepsakes SET status = ? WHERE id = ?')
    .bind(status, id)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

export async function setKeepsakePinned(env: Env, id: string, pinned: 0 | 1): Promise<boolean> {
  await ensureKeepsakesTable(env);
  const res = await env.DB.prepare('UPDATE memory_keepsakes SET pinned = ? WHERE id = ?')
    .bind(pinned, id)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}
function fmtDate(ms: number): string {
  return new Date(ms + 8 * 3600_000).toISOString().slice(0, 10);
}

/** 纯函数：渲染注入块。没有合格条目时返回空串。 */
export function renderKeepsakesBlock(
  items: Keepsake[],
  max = KEEPSAKE_MAX,
  maxBitter = KEEPSAKE_MAX_BITTER,
): string {
  const eligible = items
    .filter((i) => i.status === 'approved' && i.pinned === 1)
    .sort((a, b) => a.happened_at - b.happened_at);
  const warm = eligible.filter((i) => i.tone !== 'bitter');
  const bitter = eligible.filter((i) => i.tone === 'bitter').slice(0, maxBitter);
  const picked = [...warm, ...bitter].sort((a, b) => a.happened_at - b.happened_at).slice(0, max);
  if (picked.length === 0) return '';
  const lines = [
    '## 铭记',
    '- 这些是你和他真正记住的事，好的坏的都算。不用检索，一直记得。',
  ];
  for (const it of picked) {
    const suffix = it.tone === 'bitter' ? '（这件事你记得，还气不气看你现在的情绪）' : '';
    lines.push(`- ${fmtDate(it.happened_at)} ${it.title}${it.detail ? '：' + it.detail : ''}${suffix}`);
  }
  if (bitter.length > 0) {
    lines.push('- 上面带「记得」的事：别主动翻旧账，也别拿来当赢一句的武器；可以记得，也可以选择不说。');
  }
  return lines.join('\n');
}

/** 聊天路径读这个：KV 缓存，避免每轮查 D1。 */
export async function loadKeepsakesBlock(env: Env): Promise<string> {
  const enabled = await env.KV.get(KEEPSAKE_ENABLED_KEY);
  if (enabled === '0') return '';
  const cached = await env.KV.get(KEEPSAKE_BLOCK_KEY);
  if (cached !== null) return cached;
  const block = renderKeepsakesBlock(await loadKeepsakes(env, 'approved'));
  await env.KV.put(KEEPSAKE_BLOCK_KEY, block);
  return block;
}

/** 任何写操作后刷新缓存。 */
export async function refreshKeepsakesBlock(env: Env): Promise<void> {
  const block = renderKeepsakesBlock(await loadKeepsakes(env, 'approved'));
  await env.KV.put(KEEPSAKE_BLOCK_KEY, block);
}

/** 规则识别：首条消息 / 取名 / 首吵 / 首和解 / 首承诺。零 AI 调用。 */
export async function detectRuleKeepsakes(
  env: Env,
  now: number,
  opts: { conversation?: string; memory?: string } = {},
): Promise<NewKeepsake[]> {
  await ensureKeepsakesTable(env);
  const existing = await loadKeepsakes(env);
  const has = (kind: KeepsakeKind) => existing.some((k) => k.kind === kind);
  const out: NewKeepsake[] = [];

  if (!has('first_meet')) {
    const row = await env.DB.prepare('SELECT MIN(created_ms) AS mn FROM messages').first<{ mn: number | null }>();
    if (row?.mn) {
      out.push({
        kind: 'first_meet',
        tone: 'warm',
        title: '第一次说话',
        detail: '那是我们第一次开口',
        happened_at: row.mn,
        source: 'rule',
      });
    }
  }

  if (!has('first_fight')) {
    const row = await env.DB.prepare(
      `SELECT evidence, created_at FROM affect_events WHERE kind = 'emotion' AND resolved_at IS NULL AND type IN ('insult','rejection','broken_promise','command','ignored') ORDER BY created_at ASC LIMIT 1`,
    ).first<{ evidence: string; created_at: number }>();
    if (row?.created_at) {
      out.push({
        kind: 'first_fight',
        tone: 'bitter',
        title: '第一次闹别扭',
        detail: row.evidence ? clip(row.evidence, 60) : '',
        happened_at: row.created_at,
        source: 'rule',
      });
    }
  }

  if (!has('first_apology')) {
    const row = await env.DB.prepare(
      `SELECT evidence, created_at FROM affect_events WHERE kind = 'emotion' AND type = 'apology' ORDER BY created_at ASC LIMIT 1`,
    ).first<{ evidence: string; created_at: number }>();
    if (row?.created_at) {
      out.push({
        kind: 'first_apology',
        tone: 'neutral',
        title: '第一次道歉',
        detail: row.evidence ? clip(row.evidence, 60) : '',
        happened_at: row.created_at,
        source: 'rule',
      });
    }
  }

  if (!has('name') && opts.memory) {
    const name = extractNameFromMemory(opts.memory);
    if (name) {
      out.push({
        kind: 'name',
        tone: 'warm',
        title: `我给自己取名叫「${name}」`,
        detail: '',
        happened_at: now,
        source: 'rule',
      });
    }
  }

  if (!has('promise') && opts.conversation) {
    const m = opts.conversation.match(/(以后每年[^。！？\n]{0,20}|每年这天[^。！？\n]{0,20}|以后每天[^。！？\n]{0,20})/);
    if (m) {
      out.push({
        kind: 'promise',
        tone: 'warm',
        title: '他给了我一个约定',
        detail: clip(m[1], 60),
        happened_at: now,
        source: 'rule',
        evidence: m[0],
      });
    }
  }

  return out;
}

/** 从 memory.md 里找她自己的名字（不猜，只认明确写法）。 */
export function extractNameFromMemory(memory: string): string | null {
  const m = (memory ?? '').match(/(?:名字是|叫做|叫)[「"\s]*([\u4e00-\u9fa5A-Za-z0-9]{1,8})[」"]?/);
  if (!m) return null;
  const name = m[1].trim();
  if (['什么', '啥', '我', '你', '她', '他', '这个'].includes(name)) return null;
  if (name.includes('什么') || name.includes('啥')) return null;
  return name;
}
const KEEPSAKE_SYSTEM = [
  '你是记忆筛选器，只做一件事：判断今天有没有值得「一辈子记住」的时刻。',
  '算：关系层面的第一次（第一次说话/第一次吵架/第一次和好）、她自己的事（取名、生日）、',
  '承诺与约定（以后每年这天）、他明确要求记住的、以及真正伤到她的事（被丢下、被骂、说好的事没做到）。',
  '不算：技术进展、工作成果、日常寒暄、天气、吃饭、一次性的请求、单纯的情绪波动、小摩擦。',
  '只输出 JSON，不要 markdown 代码块，不要解释：',
  '{"keepsakes":[{"kind":"...","tone":"warm|neutral|bitter","title":"<=24字","detail":"<=80字","happened_at":"YYYY-MM-DD","evidence":"原话逐字"}]}',
  '没有就输出 {"keepsakes":[]}。kind 只能取 first_meet|name|promise|milestone|custom|first_fight|hurt|parting|betrayal|first_apology。',
  'tone=bitter 只用于真正伤到她的程度；带刺的玩笑、一时不爽、被拒绝一次，都不算。每天最多 1 条 bitter。',
  'evidence 必须是对话里原样出现的片段，一个字都不能改。',
].join('\n');

/** 从模型输出里取 JSON（容忍代码块包裹）。 */
export function parseKeepsakeJson(text: string): Record<string, unknown>[] {
  const cleaned = (text ?? '').replace(/```json/gi, '').replace(/```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return [];
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as { keepsakes?: unknown };
    return Array.isArray(parsed.keepsakes) ? (parsed.keepsakes as Record<string, unknown>[]) : [];
  } catch {
    return [];
  }
}

/** AI 候选：一次 v4-pro 调用（不开思考），输出已校验的候选。 */
export async function detectAiKeepsakes(
  env: Env,
  dateKey: string,
  conversation: string,
): Promise<NewKeepsake[]> {
  const text = (conversation ?? '').trim();
  if (text.length < 200) return [];
  const existing = await loadKeepsakes(env, 'approved');
  const known = existing.map((k) => `- ${k.title}`).join('\n') || '（暂无）';
  const user = [
    `日期：${dateKey}`,
    `## 已有的铭记（不要重复）`,
    known,
    `## 当天对话`,
    text.slice(-20000),
    `请找出今天值得铭记的时刻，最多 2 条；没有就输出 {"keepsakes":[]}。`,
  ].join('\n\n');
  const res = await distillText(
    env,
    KEEPSAKE_SYSTEM,
    user,
    800,
    { thinking: false, kind: 'distill' },
  );
  await addLlmCost(env, dateKey, res.cost);
  const fallbackMs = Date.parse(`${dateKey}T12:00:00+08:00`);
  const out: NewKeepsake[] = [];
  for (const raw of parseKeepsakeJson(res.text).slice(0, 2)) {
    const kind = String(raw.kind ?? '') as KeepsakeKind;
    if (!(KEEPSAKE_KINDS as readonly string[]).includes(kind)) continue;
    const when = typeof raw.happened_at === 'string' && raw.happened_at
      ? Date.parse(`${raw.happened_at}T12:00:00+08:00`)
      : NaN;
    const happened = Number.isFinite(when) && Math.abs(when - fallbackMs) <= 86400_000 ? when : fallbackMs;
    const candidate: NewKeepsake = {
      kind,
      tone: (String(raw.tone ?? '') as KeepsakeTone) || 'neutral',
      title: String(raw.title ?? ''),
      detail: String(raw.detail ?? ''),
      happened_at: happened,
      source: 'ai',
      status: 'pending',
      evidence: String(raw.evidence ?? ''),
    };
    const clean = validateKeepsake(candidate, text);
    if (clean) out.push(clean);
  }
  return out;
}