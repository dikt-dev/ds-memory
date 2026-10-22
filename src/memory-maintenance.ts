import { applyGradualChange, applyInactivityDecay } from './relation-growth';
import {
  applyAffinityChange,
  applyIntimacyChange,
  type AffinitySignals,
  type IntimacySignals,
} from './relation-drivers';

/**
 * memory.md 维护纯函数：
 * - mergeMemoryEntry：把提炼结果合并进现有记忆（按 ## 分类、去重、缺日期补日期）；
 * - trimOldestEntries：超限时按日期从最旧整组删除条目（顺带清理空分类）；
 * - 人物底色（IMMUTABLE_HEADER）为不可变区块：不参与合并、压缩、裁剪。
 * 条目格式：- [YYYY-MM-DD] 内容
 */

export function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

export const ENTRY_RE = /^-\s*\[(\d{4}-\d{2}-\d{2})\]/;

/**
 * 覆盖式条目：`- [日期] 键=值`（只认 = / ＝）。
 * 散文里的全角冒号不当键，避免把「沟通：短句」误判成键、把相邻条目覆盖掉。
 */
export const OVERWRITE_KEY_RE = /^-\s*\[\d{4}-\d{2}-\d{2}\]\s*([^=＝\n]{1,16})[=＝]\s*(.+)$/;

/** 会随时间变化、应当「原地覆盖」而非叠加的分区。 */
export const OVERWRITE_HEADERS: string[] = ['## 偏好与习惯', '## 关于用户'];

/**
 * 走「分层」而不是「合并」的分区：超预算时把最旧的搬进 R2 档案。
 * 这些分区不能交给 SECTION_BUDGETS 合并——合并会把不同话题摄成一条，
 * 反而降低档案检索的精度。
 */
export const DEMOTE_HEADERS: string[] = ['## 共同经历'];

/** 取条目的覆盖键（归一化后）；不是键值写法则返回 null。 */
export function overwriteKeyOf(line: string): string | null {
  const m = line.match(OVERWRITE_KEY_RE);
  return m ? normalizeForCompare(m[1]) : null;
}

/** 不可变区块："人物底色"——AI 的固定设定，永不修改/删除。 */
export const IMMUTABLE_HEADER = '## 人物底色';

/** 永不自动删除的区块（即使超容量也保留）。 */
export const PROTECTED_HEADERS: string[] = ['## 人物底色', '## 称呼与关系', '## 雷区与禁忌'];

/** 短期区块：条目按日期自动过期（只保留最近 N 天）。 */
export const TRANSIENT_HEADERS: string[] = ['## 近期动态'];
/** 短期区块保留天数。 */
export const TRANSIENT_KEEP_DAYS = 7;

/** 标准分区顺序（新分类按此顺序插入；未知分类追加在最后）。 */
export const SECTION_ORDER: string[] = [
  '## 人物底色',
  '## 称呼与关系',
  '## 关于用户',
  '## 偏好与习惯',
  '## 进行中的事项',
  '## 共同经历',
  '## 雷区与禁忌',
  '## 近期动态',
];

/** 各模块的标准注释（ensureModuleComments 会补齐缺失的注释说明）。 */
export const SECTION_COMMENTS: Record<string, string> = {
  '## 人物底色': '<!-- 固定设定，永不删改 -->',
  '## 称呼与关系': '<!-- 称呼/暗号/约定 + 三个关系值（系统算，勿手改） -->',
  '## 关于用户': '<!-- 身份、背景、重要的人（长期事实） -->',
  '## 偏好与习惯': '<!-- 喜好、厌恶、作息、沟通方式 -->',
  '## 进行中的事项': '<!-- 项目/计划/待办：[进行中]/[搁置]/[已完成] -->',
  '## 共同经历': '<!-- 共同做过的事、里程碑、梗、约定 -->',
  '## 雷区与禁忌': '<!-- 忌讳话题与说法，永不自动删除 -->',
  '## 近期动态': '<!-- 最近几天，超7天清理 -->',
};

/** 关系变量：好感度 / 亲密度 / 心情值（0-1000）。 */
export const RELATION_MAX = 1000;
export const AFFINITY_DEFAULT = 500;
export const INTIMACY_DEFAULT = 300;
export const MOOD_DEFAULT = 500;
/** 好感度/亲密度单日变化上限（慢变量）。 */
export const RELATION_MAX_DAILY_DELTA = 5;
/** 心情值单日变化上限（快变量）。 */
export const MOOD_MAX_DAILY_DELTA = 80;

const AFFINITY_VAL_RE = /好感度[:：]\s*(\d{1,4})/;
const INTIMACY_VAL_RE = /亲密度[:：]\s*(\d{1,4})/;
const MOOD_VAL_RE = /心情(?:值)?[:：]\s*(\d{1,4})/;
const AFFINITY_LINE_RE = /^-\s*好感度[:：]/;
const INTIMACY_LINE_RE = /^-\s*亲密度[:：]/;
const MOOD_LINE_RE = /^-\s*心情(?:值)?[:：]/;

interface Section {
  header: string; // 含 "## " 前缀
  lines: string[];
}

function parseSections(text: string): { pre: string; sections: Section[] } {
  const preLines: string[] = [];
  const sections: Section[] = [];
  let current: Section | null = null;
  for (const line of text.split('\n')) {
    const m = line.match(/^##\s+(.*)$/);
    if (m) {
      current = { header: `## ${m[1]}`, lines: [] };
      sections.push(current);
      continue;
    }
    if (current) current.lines.push(line);
    else preLines.push(line);
  }
  return { pre: preLines.join('\n').trimEnd(), sections };
}

function reassemble(pre: string, sections: Section[]): string {
  // 只保留有实质内容的区块（空区块不输出），但标准分区即使为空也保留头部
  const kept = sections.filter(
    (s) => s.lines.some((l) => l.trim() !== '') || SECTION_COMMENTS[s.header.trim()] !== undefined,
  );
  // 按标准顺序排列；未知分区追加在最后（保持原有相对顺序）
  const ordered = [...kept].sort((a, b) => {
    const ia = SECTION_ORDER.indexOf(a.header.trim());
    const ib = SECTION_ORDER.indexOf(b.header.trim());
    if (ia === -1 && ib === -1) return 0;
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });
  const blocks = ordered.map((s) => {
    const body = s.lines.filter((l, i, arr) => {
      // 去掉连续空行（保留区块内的单个空行分隔）
      if (l.trim() !== '') return true;
      const prev = arr[i - 1];
      return prev === undefined ? true : prev.trim() !== '';
    });
    return [s.header, ...body].join('\n');
  });
  const text = blocks.join('\n\n');
  return `${pre ? pre + '\n\n' : ''}${text}${text ? '\n' : ''}`;
}

/** 规范化内容用于去重比较（去掉标点/空白/引号差异）。 */
function normalizeForCompare(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，。、；：！？,.;:!?"'“”‘’（）()【】\[\]]/g, '');
}

/** 提炼结果中的条目行 → 规范化 "- [日期] 内容"（缺日期时用 fallbackDate 补）。 */
function normalizeBullets(lines: string[], fallbackDate?: string): string[] {
  const out: string[] = [];
  for (const raw of lines) {
    const t = raw.trim();
    if (!t) continue;
    // 关系变量由 applyRelationUpdates 单独处理，不走普通条目
    if (AFFINITY_VAL_RE.test(t) || INTIMACY_VAL_RE.test(t) || MOOD_VAL_RE.test(t)) continue;
    // 女性注释行不当作条目
    if (t.startsWith('<!--')) continue;
    const m = t.match(/^[-*]\s*(.*)$/);
    if (!m) continue;
    let content = m[1].trim();
    if (!content) continue;
    if (!/^\[\d{4}-\d{2}-\d{2}\]/.test(content) && fallbackDate) {
      content = `[${fallbackDate}] ${content}`;
    }
    out.push(`- ${content}`);
  }
  return out;
}

/**
 * 合并提炼结果：按分类并入现有记忆。
 * 同分类下完全相同的条目不重复追加；新分类追加到文件末尾。
 * 返回合并后的全文（无法解析出任何条目时原样返回）。
 */
export function mergeMemoryEntry(
  current: string,
  distilled: string,
  fallbackDate?: string,
  relationOpts: {
    streakDays?: number;
    daysSinceInteraction?: number;
    intimacy?: IntimacySignals;
    affinity?: AffinitySignals;
  } = {},
): string {
  const cur = parseSections(current);
  const dist = parseSections(distilled);
  let changed = false;

  for (const ds of dist.sections) {
    if (ds.header.trim() === IMMUTABLE_HEADER) continue; // 人物底色不可变：忽略提炼输出中的同名区块
    const bullets = normalizeBullets(ds.lines, fallbackDate);
    if (bullets.length === 0) continue;
    const existing = cur.sections.find((s) => s.header.trim() === ds.header.trim());
    if (existing) {
      const overwritable = OVERWRITE_HEADERS.includes(existing.header.trim());
      for (const b of bullets) {
        // ★ 覆盖式更新：同键（如 `作息=…`）原地替换，不叠加——避免偏好越积越多
        if (overwritable) {
          const newKey = overwriteKeyOf(b);
          if (newKey) {
            const idx = existing.lines.findIndex((l) => overwriteKeyOf(l) === newKey);
            if (idx >= 0) {
              if (existing.lines[idx] !== b) {
                existing.lines[idx] = b;
                changed = true;
              }
              continue;
            }
          }
        }
        // 归一化去重：忽略标点/空白差异，避免同一条事实被反复追加
        const key = normalizeForCompare(b.replace(/^-\s*\[\d{4}-\d{2}-\d{2}\]\s*/, ''));
        const dup = existing.lines.some((l) => {
          if (!ENTRY_RE.test(l)) return false;
          return normalizeForCompare(l.replace(/^-\s*\[\d{4}-\d{2}-\d{2}\]\s*/, '')) === key;
        });
        if (!dup) {
          existing.lines.push(b);
          changed = true;
        }
      }
    } else {
      cur.sections.push({ header: ds.header, lines: bullets });
      changed = true;
    }
  }

  // 关系变量（好感度/亲密度：渐进增长；心情值：快速变化）
  changed = applyRelationUpdates(cur, current, distilled, relationOpts) || changed;

  return changed ? reassemble(cur.pre, cur.sections) : current;
}

/**
 * 各分区的字节预算（软上限）。
 *
 * 为什么要分区管：全局只有 12KB/15KB 两个阈值，压缩是整篇重写，
 * 很容易出现「共同经历」越长越肥、把「偏好与习惯」挤掉的情况。
 * 有了分区预算，超了先在同一分区内合并同类项（不删内容），再交给全局阈值兜底。
 * 受保护分区（人物底色/称呼与关系/雷区与禁忌）不参与自动合并。
 */
export const SECTION_BUDGETS: Record<string, number> = {
  '## 人物底色': 1500,
  '## 称呼与关系': 600,
  '## 关于用户': 900,
  '## 偏好与习惯': 900,
  '## 进行中的事项': 800,
  '## 共同经历': 1000,
  '## 雷区与禁忌': 700,
  '## 近期动态': 600,
};

export interface SectionBudget {
  header: string;
  bytes: number;
  budget: number;
  over: boolean;
}

/** 报告各分区占用与预算（诊断用）。 */
export function reportSectionBudgets(text: string): SectionBudget[] {
  const { sections } = parseSections(text);
  return sections.map((s) => {
    const header = s.header.trim();
    const bytes = byteLength([s.header, ...s.lines].join('\n'));
    const budget = SECTION_BUDGETS[header] ?? 0;
    return { header, bytes, budget, over: budget > 0 && bytes > budget };
  });
}

/**
 * 分区配额软限制：超出预算的分类，把**最旧的两条合并成一条**（日期取较早那条），
 * 直到回到预算内或该区只剩一条。
 *
 * 设计取舍：
 * - 只合并、不删除 —— 用户要求「尽可能保留记忆量」，合并只去掉重复的日期前缀和行结构；
 * - 日期取较早者，保证合并项仍按「老」排序，全局 15KB 裁剪时先被处理；
 * - 受保护分区不处理（人物底色/称呼与关系/雷区与禁忌 一行都不动）；
 * - 合并后字节数没变小就停止，避免死循环。
 */
export function enforceSectionBudgets(text: string): { text: string; changed: boolean; merged: number } {
  const { pre, sections } = parseSections(text);
  const protectedHeaders = new Set(PROTECTED_HEADERS.map((h) => h.trim()));
  let merged = 0;

  for (const sec of sections) {
    const header = sec.header.trim();
    const budget = SECTION_BUDGETS[header];
    if (!budget || protectedHeaders.has(header)) continue;
    if (DEMOTE_HEADERS.includes(header)) continue; // 这类分区走分层（搬进档案），不合并

    // 只合并带日期的条目行；注释/空行/说明保持原样
    const entryIdx = sec.lines.map((l, i) => (ENTRY_RE.test(l) ? i : -1)).filter((i) => i >= 0);
    let size = byteLength([sec.header, ...sec.lines].join('\n'));

    while (size > budget && entryIdx.length >= 2) {
      const [i1, i2] = entryIdx.splice(0, 2);
      const line1 = sec.lines[i1];
      const line2 = sec.lines[i2];
      const m1 = line1.match(ENTRY_RE);
      const m2 = line2.match(ENTRY_RE);
      const date = m1?.[1] ?? m2?.[1];
      if (!date) break;
      const c1 = line1.replace(ENTRY_RE, '').trim();
      const c2 = line2.replace(ENTRY_RE, '').trim();
      const body = [c1.replace(/[；;，,]$/, ''), c2.replace(/[；;，,]$/, '')].filter(Boolean).join('；');
      const out = `- [${date}] ${body}`;

      // 合并后没变小（内容本身为空）→ 停止，避免死循环
      if (byteLength(out) >= byteLength(line1) + byteLength(line2)) break;

      sec.lines[i1] = out;
      sec.lines[i2] = '';
      merged += 1;
      size = byteLength([sec.header, ...sec.lines].join('\n'));
    }
  }

  if (merged === 0) return { text, changed: false, merged: 0 };
  const next = sections.map((sec) => ({
    header: sec.header,
    lines: sec.lines.filter((l) => l !== ''),
  }));
  return { text: reassemble(pre, next), changed: true, merged };
}

/**
 * 分层：把某个分区里最旧的条目搬出去（交由调用方写入 R2 档案层），
 * 直到全文回到 targetBytes 以内，或该区只剩 keepAtLeast 条。
 *
 * 与 trimOldestEntries 的区别：这里的条目**不会被丢弃**，而是搬到档案里按需检索，
 * 所以「核心层保持小、总量继续长」。受保护分区不参与。
 */
export function demoteSectionEntries(
  text: string,
  header: string,
  targetBytes: number,
  keepAtLeast = 4,
): { text: string; removed: string[] } {
  if (byteLength(text) <= targetBytes) return { text, removed: [] };
  const target = header.trim();
  if (PROTECTED_HEADERS.some((h) => h.trim() === target)) return { text, removed: [] };

  const { pre, sections } = parseSections(text);
  const sec = sections.find((s) => s.header.trim() === target);
  if (!sec) return { text, removed: [] };

  const entryIdx = sec.lines.map((l, i) => (ENTRY_RE.test(l) ? i : -1)).filter((i) => i >= 0);
  const removed: string[] = [];
  let size = byteLength(text);

  while (size > targetBytes && entryIdx.length > keepAtLeast) {
    const idx = entryIdx.shift() as number;
    removed.push(sec.lines[idx]);
    sec.lines[idx] = '';
    size = byteLength(reassemble(pre, sections));
  }

  if (removed.length === 0) return { text, removed: [] };
  const next = sections.map((s) => ({
    header: s.header,
    lines: s.lines.filter((l) => l !== ''),
  }));
  return { text: reassemble(pre, next), removed };
}

/**
 * 超限裁剪：从最旧日期开始整组删除条目，直到字节数 ≤ maxBytes。
 *
 * 保护规则：
 * - PROTECTED_HEADERS（人物底色 / 称呼与关系 / 雷区与禁忌）里的条目永不被裁剪
 * - 条目全部被删空的分类保留头部（标准分区），非标准分区移除
 */
export function trimOldestEntries(text: string, maxBytes: number): { text: string; removed: number } {
  if (byteLength(text) <= maxBytes) return { text, removed: 0 };

  const { pre, sections } = parseSections(text);
  // 标记受保护区块内的行
  const protectedHeaders = new Set(PROTECTED_HEADERS.map((h) => h.trim()));

  // 收集可删除条目：{ section, lineIndex, date }
  interface Cand {
    section: Section;
    idx: number;
    date: string;
  }
  const cands: Cand[] = [];
  for (const sec of sections) {
    if (protectedHeaders.has(sec.header.trim())) continue; // 受保护区块整块跳过
    sec.lines.forEach((line, idx) => {
      const m = line.match(ENTRY_RE);
      if (m) cands.push({ section: sec, idx, date: m[1] });
    });
  }
  if (cands.length === 0) return { text, removed: 0 };

  // 按日期升序（最旧的先删）
  const dates = [...new Set(cands.map((c) => c.date))].sort((a, b) => a.localeCompare(b));
  const removedDates = new Set<string>();
  let removed = 0;

  const buildWith = (skip: Set<string>): string => {
    const next = sections.map((sec) => {
      // 受保护区块：一行都不删
      if (protectedHeaders.has(sec.header.trim())) return sec;
      return {
        header: sec.header,
        lines: sec.lines.filter((line) => {
          const m = line.match(ENTRY_RE);
          return !(m && skip.has(m[1]));
        }),
      };
    });
    return reassemble(pre, next);
  };

  for (const date of dates) {
    removedDates.add(date);
    removed += cands.filter((c) => c.date === date).length;
    if (byteLength(buildWith(removedDates)) <= maxBytes) break;
  }

  return { text: buildWith(removedDates), removed };
}

/**
 * 清理短期区块（近期动态）里超过 keepDays 天的条目。
 * @param today 今天的日期键（YYYY-MM-DD）
 */
export function pruneTransientSections(
  text: string,
  today: string,
  keepDays = TRANSIENT_KEEP_DAYS,
): { text: string; removed: number } {
  const { pre, sections } = parseSections(text);
  const transient = new Set(TRANSIENT_HEADERS.map((h) => h.trim()));
  const cutoff = shiftDate(today, -keepDays);
  let removed = 0;

  const next = sections.map((sec) => {
    if (!transient.has(sec.header.trim())) return sec;
    const lines = sec.lines.filter((line) => {
      const m = line.match(ENTRY_RE);
      if (!m) return true; // 注释与空行保留
      if (m[1] < cutoff) {
        removed += 1;
        return false;
      }
      return true;
    });
    return { header: sec.header, lines };
  });

  if (removed === 0) return { text, removed: 0 };
  return { text: reassemble(pre, next), removed };
}

/** 日期加减（YYYY-MM-DD）。 */
function shiftDate(dateKey: string, deltaDays: number): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + deltaDays));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

/* ---------- 已完成事项自动归档 ---------- */

const PENDING_HEADER = '## 进行中的事项';
const SHARED_HEADER = '## 共同经历';

/** 「已完成」标记的正则（兼容全角括号与不同写法）。 */
const DONE_RE = /\[(已完成|完成|done)\]/i;

interface PendingArchiveOptions {
  /** 标记已完成多少天后才归档（给用户一个反悔窗口）。 */
  graceDays?: number;
}

export const PENDING_ARCHIVE_GRACE_DAYS = 3;

/**
 * 把「进行中的事项」里标了 [已完成] 且超过 graceDays 的条目，
 * 自动搬到「共同经历」里（作为一起做成的事）。
 *
 * 按日期判断宽限期，避免刚标完成就搬走。
 */
export function archiveCompletedItems(
  text: string,
  today: string,
  opts: PendingArchiveOptions = {},
): { text: string; moved: number; titles: string[] } {
  const graceDays = opts.graceDays ?? PENDING_ARCHIVE_GRACE_DAYS;
  const cutoff = shiftDate(today, -graceDays);
  const { pre, sections } = parseSections(text);

  const pending = sections.find((s) => s.header.trim() === PENDING_HEADER);
  if (!pending) return { text, moved: 0, titles: [] };

  const toMove: string[] = [];
  const remaining: string[] = [];

  for (const line of pending.lines) {
    const m = line.match(ENTRY_RE);
    // 非条目行、未标完成、或还没过宽限期 → 留在原处
    if (!m || !DONE_RE.test(line) || m[1] > cutoff) {
      remaining.push(line);
      continue;
    }
    toMove.push(line);
  }

  if (toMove.length === 0) return { text, moved: 0, titles: [] };

  // 写入「共同经历」：去掉状态标记，换成「已完成」的叙述
  const titles: string[] = [];
  const archived = toMove.map((line) => {
    const m = line.match(/^-\s*\[(\d{4}-\d{2}-\d{2})\]\s*(.*)$/);
    const date = m?.[1] ?? today;
    let content = (m?.[2] ?? line).trim();
    // 去掉 [已完成] 之类的标记
    content = content.replace(DONE_RE, '').trim();
    titles.push(content.slice(0, 20));
    return `- [${date}] 完成了：${content}`;
  });

  const next = sections.map((sec) => {
    if (sec.header.trim() === PENDING_HEADER) {
      return { header: sec.header, lines: remaining };
    }
    return sec;
  });

  let shared = next.find((s) => s.header.trim() === SHARED_HEADER);
  if (!shared) {
    shared = { header: SHARED_HEADER, lines: [] };
    next.push(shared);
  }
  shared.lines.push(...archived);

  return { text: reassemble(pre, next), moved: toMove.length, titles };
}

/**
 * 拆出"人物底色"区块（压缩时先取出，压缩完原样放回，保证 AI 无法改动它）。
 * 返回的 body 不含该区块。
 */
export function extractImmutableSection(text: string): { body: string; section: string | null } {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.trim() === IMMUTABLE_HEADER);
  if (start === -1) return { body: text, section: null };
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  const section = lines.slice(start, end).join('\n').trimEnd();
  const body = [...lines.slice(0, start), ...lines.slice(end)].join('\n');
  return { body, section };
}

/** 把"人物底色"区块放回（放在第一个分类位置，保持固定顺序）。 */
export function injectImmutableSection(body: string, section: string): string {
  const { pre, sections } = parseSections(body);
  const rest = sections.filter((s) => s.header.trim() !== IMMUTABLE_HEADER);
  const parts = [pre.trimEnd(), section, ...rest.map((s) => [s.header, ...s.lines].join('\n'))].filter(Boolean);
  return parts.join('\n\n') + '\n';
}

/* ---------- 关系变量（好感度 / 亲密度） ---------- */

function clampInt(n: number, min: number, max: number): number {
  return Math.min(Math.max(Math.round(n), min), max);
}

export interface RelationValues {
  affinity: number;
  intimacy: number;
  mood: number;
}

function extractValue(text: string, re: RegExp): number | null {
  for (const line of text.split('\n')) {
    const m = line.match(re);
    if (m) return clampInt(Number(m[1]), 0, RELATION_MAX);
  }
  return null;
}

/** 解析好感度/亲密度/心情值（缺失时取默认值）。 */
export function parseRelationValues(text: string): RelationValues {
  return {
    affinity: extractValue(text, AFFINITY_VAL_RE) ?? AFFINITY_DEFAULT,
    intimacy: extractValue(text, INTIMACY_VAL_RE) ?? INTIMACY_DEFAULT,
    mood: extractValue(text, MOOD_VAL_RE) ?? MOOD_DEFAULT,
  };
}

/** 单日变化截断（保留兼容；新逻辑用 applyGradualChange）。 */
export function applyRelationDelta(current: number, proposed: number, maxDelta = RELATION_MAX_DAILY_DELTA): number {
  const delta = Math.min(Math.max(proposed - current, -maxDelta), maxDelta);
  return clampInt(current + delta, 0, RELATION_MAX);
}

function setValueLine(section: Section, lineRe: RegExp, label: string, value: number): boolean {
  const next = `- ${label}：${value} / ${RELATION_MAX}`;
  for (let i = 0; i < section.lines.length; i++) {
    if (lineRe.test(section.lines[i].trim())) {
      if (section.lines[i].trim() !== next) {
        section.lines[i] = next;
        return true;
      }
      return false;
    }
  }
  section.lines.push(next);
  return true;
}

/** 确保记忆文本中有三个关系变量行（压缩后恢复用）。 */
export function setRelationValues(text: string, values: RelationValues): string {
  const parsed = parseSections(text);
  let section = parsed.sections.find((s) => s.header.trim() === '## 称呼与关系');
  if (!section) {
    section = { header: '## 称呼与关系', lines: [] };
    parsed.sections.push(section);
  }
  setValueLine(section, AFFINITY_LINE_RE, '好感度', values.affinity);
  setValueLine(section, INTIMACY_LINE_RE, '亲密度', values.intimacy);
  setValueLine(section, MOOD_LINE_RE, '心情值', values.mood);
  return reassemble(parsed.pre, parsed.sections);
}

/**
 * 应用关系变量变化（C1：数值由代码算，AI 不再提议）。
 * - 亲密度：由互动量驱动（relation-drivers）
 * - 好感度：由互动质量驱动（relation-drivers）
 * - 心情值：仍由 AI 提议，但受 ±80 单日上限
 *
 * 传入 drivers 时忽略 AI 提出的好感/亲密数值；未传时回退旧渐进模型（兼容旧调用）。
 */
function applyRelationUpdates(
  cur: { pre: string; sections: Section[] },
  currentText: string,
  distilled: string,
  opts: {
    streakDays?: number;
    daysSinceInteraction?: number;
    intimacy?: IntimacySignals;
    affinity?: AffinitySignals;
  } = {},
): boolean {
  const proposedMood = extractValue(distilled, MOOD_VAL_RE);
  const hasDrivers = Boolean(opts.intimacy || opts.affinity);
  if (!hasDrivers && proposedMood === null) return false;

  const currentVals = parseRelationValues(currentText);
  let section = cur.sections.find((s) => s.header.trim() === '## 称呼与关系');
  if (!section) {
    section = { header: '## 称呼与关系', lines: [] };
    cur.sections.push(section);
  }
  let changed = false;

  // ① 亲密度：由「量」驱动
  if (opts.intimacy) {
    const r = applyIntimacyChange(currentVals.intimacy, opts.intimacy);
    changed = setValueLine(section, INTIMACY_LINE_RE, '亲密度', r.next) || changed;
  } else if (!hasDrivers) {
    const proposed = extractValue(distilled, INTIMACY_VAL_RE);
    if (proposed !== null) {
      const r = applyGradualChange(currentVals.intimacy, proposed, opts);
      changed = setValueLine(section, INTIMACY_LINE_RE, '亲密度', r.next) || changed;
    }
  }

  // ② 好感度：由「质」驱动
  if (opts.affinity) {
    const r = applyAffinityChange(currentVals.affinity, opts.affinity);
    changed = setValueLine(section, AFFINITY_LINE_RE, '好感度', r.next) || changed;
  } else if (!hasDrivers) {
    const proposed = extractValue(distilled, AFFINITY_VAL_RE);
    if (proposed !== null) {
      const r = applyGradualChange(currentVals.affinity, proposed, opts);
      changed = setValueLine(section, AFFINITY_LINE_RE, '好感度', r.next) || changed;
    }
  }

  // ③ 心情值：AI 提议 + ±80 截断
  if (proposedMood !== null) {
    const delta = Math.min(Math.max(proposedMood - currentVals.mood, -MOOD_MAX_DAILY_DELTA), MOOD_MAX_DAILY_DELTA);
    const next = clampInt(currentVals.mood + delta, 0, RELATION_MAX);
    changed = setValueLine(section, MOOD_LINE_RE, '心情值', next) || changed;
  }
  return changed;
}

/** 长期不联系时的关系衰减。
 *
 * 按新设计（两者独立）：
 * - 亲密度：缓降（不见面就生疏）
 * - 好感度：**不降**（“喜欢”不会因为一段时间没见就减少）
 */
export function applyRelationDecay(
  currentText: string,
  daysSinceInteraction: number,
): { text: string; changed: boolean; note?: string } {
  if (daysSinceInteraction <= 7) return { text: currentText, changed: false };

  const vals = parseRelationValues(currentText);
  const inti = applyInactivityDecay(vals.intimacy, daysSinceInteraction);
  if (inti.applied === 0) return { text: currentText, changed: false };

  const updated = setRelationValues(currentText, {
    affinity: vals.affinity, // 保持不动
    intimacy: inti.next,
    mood: vals.mood,
  });
  return {
    text: updated,
    changed: true,
    note: `已 ${daysSinceInteraction} 天没联系，亲密度 ${inti.applied}（好感度不变）`,
  };
}

/**
 * 给已知模块补齐"用途注释"（幂等：已有注释不重复添加）。
 * 压缩后调用，保证每个模块下始终有一条说明注释。
 */
export function ensureModuleComments(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    out.push(line);
    const comment = SECTION_COMMENTS[line.trim()];
    if (!comment) continue;
    // 看下一行（跳过空行）是否已是注释
    let j = i + 1;
    while (j < lines.length && lines[j].trim() === '') j++;
    const nextIsComment = j < lines.length && lines[j].trim().startsWith('<!--');
    if (!nextIsComment) out.push('', comment, '');
  }
  return out.join('\n');
}
