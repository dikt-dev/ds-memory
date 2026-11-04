import { applyGradualChange, applyInactivityDecay } from './relation-growth';
import {
  applyAffinityChange,
  applyIntimacyChange,
  type AffinitySignals,
  type IntimacySignals,
} from './relation-drivers';
import { RELATION_MAX, MOOD_MAX_DAILY_DELTA } from './relation-model';

/**
 * memory.md 维护纯函数：
 * - mergeMemoryEntry：把提炼结果合并进现有记忆（按 ## 分类、去重、缺日期补日期）；
 * - trimOldestEntries：超限时按日期从最旧整组删除条目（顺带清理空分类）；
 * - 人物底色（IMMUTABLE_HEADER）为不可变区块：不参与合并、压缩、裁剪。
 * 条目格式：- [YY-MM-DD] 内容（兼容旧的 YYYY-MM-DD）
 */

export function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * 注入提示词前压缩 memory.md 的“非信息”部分（不改 R2 里的原文件）：
 * - 去掉 <!-- 注释 -->、模板说明的 > 引用行；
 * - 去掉空行与行尾空白；
 * - 超过 maxBytes 时，优先把「共同经历 / 近期动态 / 进行中的事」里最旧的条目
 *   从本次提示词里拿掉（文件里仍保留，档案层以后还能召回），
 *   最后才按日期裁最旧条目。受保护分区（底色/称呼/雷区）不动。
 *
 * 事实、日期、分区标题全部保留，因此不会改变文件本身。
 */
/** 提示词里 memory 段的硬上限（full 模式）。evidence 模式只带宪法，用不到这个上限。 */
export const MEMORY_PROMPT_MAX_BYTES = 32768;

function stripMemoryForPrompt(text: string): string {
  const lines = text
    .replace(/\r\n/g, '\n')
    .replace(/<!--[\s\S]*?-->/g, '')
    .split('\n');
  const out: string[] = [];
  for (const raw of lines) {
    const line = raw.replace(/[ \t]+$/g, '');
    if (!line.trim()) continue;
    if (line.trimStart().startsWith('>')) continue;
    out.push(line);
  }
  return out.join('\n').trim();
}

/**
 * 会「小时内变化」的分区：单独放到易变段，避免它一变就把整段前缀缓存冲掉。
 * 其余分区（人物底色/称呼/关于他/偏好/共同经历/雷区）都按天级变化，留在稳定段。
 * 未识别的分区默认归稳定段——宁可缓存吃亏，也不丢内容。
 */
export const VOLATILE_MEMORY_HEADERS: string[] = ['进行中的事', '近期动态'];

function splitSections(text: string): {
  preamble: string[];
  sections: Array<{ name: string; body: string }>;
} {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const sections: Array<{ name: string; body: string }> = [];
  const preamble: string[] = [];
  let cur: { name: string; body: string } | null = null;
  for (const line of lines) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) {
      if (cur) sections.push(cur);
      cur = { name: m[1].trim(), body: '' };
    } else if (cur) {
      cur.body += line + '\n';
    } else {
      preamble.push(line);
    }
  }
  if (cur) sections.push(cur);
  return { preamble, sections };
}

/**
 * 进提示词前瘦身：空分区不输出、去掉重复的 H1、今年的日期省掉年份。
 *
 * 为什么：记忆为空时，模型会收到一排只有标题、下面是空白的 `## 分区`——
 * 既费 token，又容易被读成"这件事她一点都不记得"。日记/记忆这类长文档里，
 * 空白标题比它占的字数更误导。
 */
export function slimMemoryForPrompt(text: string, now: Date = new Date()): string {
  if (!text.trim()) return '';
  const beijing = new Date(now.getTime() + 8 * 3600_000);
  const year = String(beijing.getUTCFullYear());
  const todayDay = Math.floor(
    Date.UTC(beijing.getUTCFullYear(), beijing.getUTCMonth(), beijing.getUTCDate()) / 86400_000,
  );
  /** [2026-11-04] / [26-11-04] → 「今天」「昨天」「3 天前」；「近期动态」用得上。 */
  const ageOf = (y: string, m: string, d: string): string | null => {
    const full = y.length === 2 ? Number('20' + y) : Number(y);
    const day = Math.floor(Date.UTC(full, Number(m) - 1, Number(d)) / 86400_000);
    const diff = todayDay - day;
    if (!Number.isFinite(diff) || diff < 0) return null;
    if (diff === 0) return '今天';
    if (diff === 1) return '昨天';
    return `${diff} 天前`;
  };

  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let section: string | null = null;
  let pendingHeader: string | null = null;
  let sectionHasBody = false;

  const flush = (): void => {
    if (pendingHeader !== null && sectionHasBody) out.push(pendingHeader);
    pendingHeader = null;
    sectionHasBody = false;
  };
  const emit = (line: string): void => {
    if (pendingHeader !== null) {
      out.push(pendingHeader);
      section = pendingHeader.replace(/^##\s+/, '').trim();
      pendingHeader = null;
    }
    out.push(line);
    sectionHasBody = true;
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/[ \t]+$/g, '');
    if (/^##\s/.test(line)) {
      flush();
      pendingHeader = line;
      continue;
    }
    // 一级标题和提示词里的标题重复
    if (/^#\s/.test(line)) continue;
    if (!line.trim()) {
      if (sectionHasBody) out.push('');
      continue;
    }
    // 日期：存储是 YY-MM-DD；这里把今年的缩成 MM-DD，并给「近期动态」补相对时间
    let rendered = line.replace(
      /\[(\d{2,4})-(\d{2})-(\d{2})\]/g,
      (all, y: string, m: string, d: string) => (y.length === 4 && y !== year ? all : `[${m}-${d}]`),
    );
    if (section === '近期动态') {
      rendered = rendered.replace(
        /- \[(\d{2,4})-(\d{2})-(\d{2})\]/,
        (all: string, y: string, m: string, d: string) => {
          const age = ageOf(y, m, d);
          return age ? `${all}（${age}）` : all;
        },
      );
    }
    emit(rendered);
  }
  flush();
  return out.join('\n').trim();
}

export function splitMemoryForPrompt(
  text: string,
  maxBytes = MEMORY_PROMPT_MAX_BYTES,
): { stable: string; volatile: string } {
  const { preamble, sections } = splitSections(text);
  const stableParts: string[] = [preamble.join('\n')];
  const volatileParts: string[] = [];
  for (const section of sections) {
    const chunk = `## ${section.name}\n${section.body}`;
    (VOLATILE_MEMORY_HEADERS.includes(section.name) ? volatileParts : stableParts).push(chunk);
  }
  return {
    stable: compactMemoryForPrompt(stableParts.join('\n'), maxBytes),
    volatile: compactMemoryForPrompt(volatileParts.join('\n'), maxBytes),
  };
}

export function compactMemoryForPrompt(
  text: string,
  maxBytes = MEMORY_PROMPT_MAX_BYTES,
): string {
  let out = stripMemoryForPrompt(text);
  if (!maxBytes || byteLength(out) <= maxBytes) return out;

  // 先牺牲“共同经历/近期动态”，再牺牲进行中的事；稳定事实最后才动
  for (const header of ['## 共同经历', '## 近期动态', '## 进行中的事']) {
    if (byteLength(out) <= maxBytes) break;
    out = demoteSectionEntries(out, header, maxBytes).text;
  }
  if (byteLength(out) > maxBytes) {
    out = trimOldestEntries(out, maxBytes).text;
  }
  return stripMemoryForPrompt(out);
}

const DATE_PART = '(?:(?:\\d{4}|\\d{2})-\\d{2}-\\d{2})';
export const ENTRY_RE = new RegExp(`^-\\s*\\[(${DATE_PART})\\]`);
export const ENTRY_PREFIX_RE = new RegExp(`^-\\s*\\[${DATE_PART}\\]\\s*`);
export const DATE_PREFIX_RE = new RegExp(`^\\[${DATE_PART}\\]`);

/** 把 `26-10-23` / `2026-10-23` 统一成 4 位年份，便于日期比较。 */
export function normalizeDateKey(date: string): string {
  const [y, m, d] = date.split('-');
  if (!y || !m || !d) return date;
  return y.length === 2 ? `20${y}-${m}-${d}` : `${y}-${m}-${d}`;
}

/** 把 `2026-10-23` 缩成 `26-10-23`（新条目写入用）。 */
export function compactDateKey(date: string): string {
  const full = normalizeDateKey(date);
  return full.length === 10 ? full.slice(2) : full;
}

/**
 * 覆盖式条目：`- [日期] 键=值`（只认 = / ＝）。
 * 散文里的全角冒号不当键，避免把「沟通：短句」误判成键、把相邻条目覆盖掉。
 */
export const OVERWRITE_KEY_RE = new RegExp(
  `^-\\s*\\[${DATE_PART}\\]\\s*([^=＝\\n]{1,16})[=＝]\\s*(.+)$`,
);

/** 会随时间变化、应当「原地覆盖」而非叠加的分区。 */
export const OVERWRITE_HEADERS: string[] = ['## 他的偏好', '## 关于他'];

/** 取条目的覆盖键（归一化后）；不是键值写法则返回 null。 */
export function overwriteKeyOf(line: string): string | null {
  const m = line.match(OVERWRITE_KEY_RE);
  return m ? normalizeForCompare(m[1]) : null;
}

/** 不可变区块："人物底色"——AI 的固定设定，永不修改/删除。 */
export const IMMUTABLE_HEADER = '## 人物底色';

/** 永不自动删除的区块（即使超容量也保留）。 */
export const PROTECTED_HEADERS: string[] = ['## 人物底色', '## 称呼与关系', '## 他的雷区'];

/** 短期区块：条目按日期自动过期（只保留最近 N 天）。 */
export const TRANSIENT_HEADERS: string[] = ['## 近期动态'];
/** 短期区块保留天数。 */
/**
 * 「近期动态」在常驻层保留多少天。
 *
 * 之前 7 天：一周后整段搬进 archive.md，而 archive 不进提示词——
 * 「上周三他说想辞职」这种正需要被想起来的事，一周后就想不起来了。
 * 30 天覆盖"最近一个月"的对话语境；再久的事件本来就该进「共同经历」。
 */
export const TRANSIENT_KEEP_DAYS = 30;

/** 标准分区顺序（新分类按此顺序插入；未知分类追加在最后）。 */
export const SECTION_ORDER: string[] = [
  // 硬约束放最前：模型读长文里中段的注意力会衰减，边界不能排在最后
  '## 人物底色',
  '## 他的雷区',
  '## 称呼与关系',
  '## 关于他',
  '## 他的偏好',
  '## 进行中的事',
  '## 共同经历',
  '## 你的生活',
  '## 近期动态',
];

/** 各模块的标准注释（ensureModuleComments 会补齐缺失的注释说明）。 */
export const SECTION_COMMENTS: Record<string, string> = {
  '## 人物底色': '<!-- 固定设定，永不删改 -->',
  '## 称呼与关系': '<!-- 称呼/暗号/约定 + 三个关系值（系统算，勿手改） -->',
  '## 关于他': '<!-- 他的身份、背景、重要的人（长期事实） -->',
  '## 他的偏好': '<!-- 他的喜好、厌恶、作息、沟通方式 -->',
  '## 进行中的事': '<!-- 他的项目/计划/待办：[进行中]/[搁置]/[已完成] -->',
  '## 共同经历': '<!-- 共同做过的事、里程碑、梗、约定 -->',
  '## 你的生活': '<!-- 你自己的事：去过哪、在追什么、自己做的决定 -->',
  '## 他的雷区': '<!-- 他不能碰的话题与说法，永不自动删除 -->',
  '## 近期动态': '<!-- 最近几天，超7天清理 -->',
};

/** 关系变量：好感度 / 亲密度 / 心情值（0-1000）。 */
// 常量统一来自 relation-model（保持 export 以兼容既有引用）
export const AFFINITY_DEFAULT = 500;
export const INTIMACY_DEFAULT = 300;
export const MOOD_DEFAULT = 500;
/** 信任默认值：刚认识有基础信任，但不是全盘托付。 */
export const TRUST_DEFAULT = 600;
/** 尊重默认值：默认平等相处。 */
export const RESPECT_DEFAULT = 650;
/** 心动默认值：新关系不自带暧昧。 */
export const ATTRACTION_DEFAULT = 300;
/** 心情值单日变化上限（快变量）。 */
// 常量统一来自 relation-model（保持 export 以兼容既有引用）

const AFFINITY_VAL_RE = /好感度[:：]\s*(\d{1,4})/;
const INTIMACY_VAL_RE = /亲密度[:：]\s*(\d{1,4})/;
const MOOD_VAL_RE = /心情(?:值)?[:：]\s*(\d{1,4})/;
const TRUST_VAL_RE = /信任[:：]\s*(\d{1,4})/;
const RESPECT_VAL_RE = /尊重[:：]\s*(\d{1,4})/;
const ATTRACTION_VAL_RE = /心动[:：]\s*(\d{1,4})/;
const AFFINITY_LINE_RE = /^-\s*好感度[:：]/;
const INTIMACY_LINE_RE = /^-\s*亲密度[:：]/;
const MOOD_LINE_RE = /^-\s*心情(?:值)?[:：]/;
const TRUST_LINE_RE = /^-\s*信任[:：]/;
const RESPECT_LINE_RE = /^-\s*尊重[:：]/;
const ATTRACTION_LINE_RE = /^-\s*心动[:：]/;

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
    // 女性注释行不当作条目
    if (t.startsWith('<!--')) continue;
    const m = t.match(/^[-*]\s*(.*)$/);
    if (!m) continue;
    let content = m[1].trim();
    if (!content) continue;
    // 关系变量由 applyRelationUpdates 单独处理，不走普通条目。
    // 必须在去掉 bullet 后判断，否则 `- 好感度：...` 会漏成普通条目。
    if (/^(好感度|亲密度|心情值?|信任|尊重|心动)\s*[:：]/.test(content)) continue;
    if (!DATE_PREFIX_RE.test(content) && fallbackDate) {
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

  // 模型有时只输出裸 bullet、不带 `## 分区`。不能静默丢掉，
  // 先落到“近期动态”，至少保证当天内容进入记忆。
  const looseBullets = normalizeBullets(dist.pre.split('\n'), fallbackDate);
  if (looseBullets.length > 0) {
    let target = cur.sections.find((s) => s.header.trim() === '## 近期动态');
    if (!target) {
      target = { header: '## 近期动态', lines: [] };
      cur.sections.push(target);
    }
    for (const b of looseBullets) {
      const key = normalizeForCompare(b.replace(ENTRY_PREFIX_RE, ''));
      const dup = target.lines.some(
        (l) => ENTRY_RE.test(l) && normalizeForCompare(l.replace(ENTRY_PREFIX_RE, '')) === key,
      );
      if (!dup) {
        target.lines.push(b);
        changed = true;
      }
    }
  }

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
        const key = normalizeForCompare(b.replace(ENTRY_PREFIX_RE, ''));
        const dup = existing.lines.some((l) => {
          if (!ENTRY_RE.test(l)) return false;
          return normalizeForCompare(l.replace(ENTRY_PREFIX_RE, '')) === key;
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
 * 很容易出现「共同经历」越长越肥、把「他的偏好」挤掉的情况。
 * 有了分区预算，超了先在同一分区内合并同类项（不删内容），再交给全局阈值兜底。
 * 受保护分区（人物底色/称呼与关系/他的雷区）不参与自动合并。
 */
export const SECTION_BUDGETS: Record<string, number> = {
  '## 人物底色': 2000,
  '## 称呼与关系': 800,
  '## 关于他': 2000,
  '## 他的偏好': 1800,
  '## 进行中的事': 1500,
  '## 共同经历': 3000,
  '## 你的生活': 1200,
  '## 他的雷区': 1200,
  '## 近期动态': 800,
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
 * 按分区预算降级：只量该分区自身字节，超了就把最旧的条目搬出去（调用方写入档案）。
 *
 * 与 demoteSectionEntries 的区别：那个比的是全文体积，语义是"整篇太大"；
 * 这里是"这一节太胖"，用来提前拦住 16KB 的分界线——超过它记忆会从全量注入
 * 掉成 compact，共同经历/进行中的事会整段退出提示词。
 */
export function demoteSectionToBudget(
  text: string,
  header: string,
  budgetBytes: number,
  keepAtLeast = 6,
): { text: string; removed: string[] } {
  const target = header.trim();
  if (PROTECTED_HEADERS.some((h) => h.trim() === target)) return { text, removed: [] };
  const { pre, sections } = parseSections(text);
  const sec = sections.find((s) => s.header.trim() === target);
  if (!sec) return { text, removed: [] };

  const sizeOf = (): number => byteLength([sec.header, ...sec.lines].join('\n'));
  const entryIdx = sec.lines.map((l, i) => (ENTRY_RE.test(l) ? i : -1)).filter((i) => i >= 0);
  const removed: string[] = [];
  while (sizeOf() > budgetBytes && entryIdx.length > keepAtLeast) {
    const idx = entryIdx.shift() as number;
    removed.push(sec.lines[idx]);
    sec.lines[idx] = '';
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
 * - PROTECTED_HEADERS（人物底色 / 称呼与关系 / 他的雷区）里的条目永不被裁剪
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
      if (m) cands.push({ section: sec, idx, date: normalizeDateKey(m[1]) });
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
          return !(m && skip.has(normalizeDateKey(m[1])));
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
): { text: string; removed: number; removedLines: string[] } {
  const { pre, sections } = parseSections(text);
  const transient = new Set(TRANSIENT_HEADERS.map((h) => h.trim()));
  const cutoff = shiftDate(today, -keepDays);
  let removed = 0;
  const removedLines: string[] = [];

  const next = sections.map((sec) => {
    if (!transient.has(sec.header.trim())) return sec;
    const lines = sec.lines.filter((line) => {
      const m = line.match(ENTRY_RE);
      if (!m) return true; // 注释与空行保留
      // 带日期的关系快照只是历史展示，当前值在“称呼与关系”里；
      // 不要让 [2026-10-24] 心情值 这种旧行在近期动态里冒充当前值。
      if (/^-\s*\[[^\]]+\]\s*(好感度|亲密度|心情值?|信任|尊重|心动)\s*[:：]/.test(line)) {
        removed += 1;
        removedLines.push(line);
        return false;
      }
      if (normalizeDateKey(m[1]) < cutoff) {
        removed += 1;
        removedLines.push(line);
        return false;
      }
      return true;
    });
    return { header: sec.header, lines };
  });

  if (removed === 0) return { text, removed: 0, removedLines: [] };
  return { text: reassemble(pre, next), removed, removedLines };
}

/* ---------- 记忆密度：保守去重 ---------- */

export interface MemoryCompactionResult {
  text: string;
  removed: number;
  merged: number;
}

function entryContent(line: string): string | null {
  if (!ENTRY_RE.test(line)) return null;
  return line.replace(ENTRY_PREFIX_RE, '').trim() || null;
}

function entryDateOf(line: string): string | null {
  const m = line.match(ENTRY_RE);
  return m ? normalizeDateKey(m[1]) : null;
}

/**
 * 保守的密度整理（不改事实，只去重）：
 * - 「关于他」「他的偏好」：同键取最新值；同内容取信息量最大的一条（日期取最早）；
 * - 其它分区：只合并「同一天、同内容」的重复条目，避免把不同日期发生的事误删；
 * - 受保护分区（人物底色/称呼/雷区）一行不动。
 *
 * 返回 removed 便于写日志和统计；不删除任何分区标题。
 */
export function compactMemoryEntries(text: string): MemoryCompactionResult {
  const { pre, sections } = parseSections(text);
  let removed = 0;
  let merged = 0;

  for (const sec of sections) {
    const header = sec.header.trim();
    if (PROTECTED_HEADERS.includes(header)) continue;
    const profile = OVERWRITE_HEADERS.includes(header);
    const out: string[] = [];
    const seen = new Map<string, number>();

    for (const line of sec.lines) {
      const content = entryContent(line);
      if (content === null) {
        out.push(line);
        continue;
      }
      const date = entryDateOf(line);
      const keyed = profile && overwriteKeyOf(line) !== null;
      const key = profile
        ? (overwriteKeyOf(line) ?? normalizeForCompare(content))
        : `${date ?? ''}|${normalizeForCompare(content)}`;
      let idx = seen.get(key);

      // profile 区允许「包含关系」的近似重复：例如旧条目「用户是 C 开发者」
      // 与新条目「用户是 C 开发者，做跨端聊天软件」只保留信息更全的那条。
      if (idx === undefined && profile && !keyed) {
        const norm = normalizeForCompare(content);
        if (norm.length >= 6) {
          for (let i = 0; i < out.length; i++) {
            const other = entryContent(out[i]);
            if (!other || overwriteKeyOf(out[i]) !== null) continue;
            const otherNorm = normalizeForCompare(other);
            if (otherNorm.length >= 6 && (otherNorm.includes(norm) || norm.includes(otherNorm))) {
              idx = i;
              break;
            }
          }
        }
      }

      if (idx === undefined) {
        seen.set(key, out.length);
        out.push(line);
        continue;
      }

      // 重复：
      // - 键=值：新日期覆盖旧值（避免把“职业=Go”改回旧的“职业=C…”）；
      // - 普通内容：保留更长（信息更全）的正文；profile 区日期取最早，事件区日期必然相同。
      const prev = out[idx];
      const prevContent = entryContent(prev) ?? '';
      const prevDate = entryDateOf(prev);
      const bothKeyed = keyed && overwriteKeyOf(prev) !== null;
      const newer = Boolean(date && prevDate && date > prevDate);
      const keep = bothKeyed ? (newer ? content : prevContent) : content.length > prevContent.length ? content : prevContent;
      const keepDate = bothKeyed
        ? (newer ? date : prevDate) ?? date ?? prevDate
        : profile
          ? [prevDate, date].filter(Boolean).sort()[0] ?? null
          : (prevDate ?? date);
      out[idx] = `- [${compactDateKey(keepDate ?? '')}] ${keep}`;
      removed += 1;
      merged += 1;
    }
    sec.lines = out;
  }

  if (removed === 0) return { text, removed: 0, merged: 0 };
  return { text: reassemble(pre, sections), removed, merged };
}

/** 记忆密度指标：条目数、字节数、平均每条字节。 */
export function memoryDensity(text: string): { entries: number; bytes: number; bytesPerEntry: number } {
  const entries = (text.match(/^-\s*\[(?:\d{4}|\d{2})-\d{2}-\d{2}\]/gm) ?? []).length;
  const bytes = byteLength(text);
  return { entries, bytes, bytesPerEntry: entries > 0 ? Math.round(bytes / entries) : 0 };
}

/** 日期加减（YYYY-MM-DD）。 */
function shiftDate(dateKey: string, deltaDays: number): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + deltaDays));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

/* ---------- 已完成事项自动归档 ---------- */

const PENDING_HEADER = '## 进行中的事';
const SHARED_HEADER = '## 共同经历';

/** 「已完成」标记的正则（兼容全角括号与不同写法）。 */
const DONE_RE = /\[(已完成|完成|done)\]/i;

interface PendingArchiveOptions {
  /** 标记已完成多少天后才归档（给用户一个反悔窗口）。 */
  graceDays?: number;
}

export const PENDING_ARCHIVE_GRACE_DAYS = 3;

/**
 * 把「进行中的事」里标了 [已完成] 且超过 graceDays 的条目，
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
    const date = m ? normalizeDateKey(m[1]) : '';
    // 非条目行、未标完成、或还没过宽限期 → 留在原处
    if (!m || !DONE_RE.test(line) || date > cutoff) {
      remaining.push(line);
      continue;
    }
    toMove.push(line);
  }

  if (toMove.length === 0) return { text, moved: 0, titles: [] };

  // 写入「共同经历」：去掉状态标记，换成「已完成」的叙述
  const titles: string[] = [];
  const archived = toMove.map((line) => {
    const m = line.match(ENTRY_RE);
    const date = m ? compactDateKey(m[1]) : compactDateKey(today);
    let content = m ? line.replace(ENTRY_PREFIX_RE, '').trim() : line.trim();
    // 去掉 [已完成] 之类的标记
    content = content.replace(DONE_RE, '').trim();
    titles.push(content.slice(0, 20));
    // 共同经历里直接保留原事项，不再加“完成了：”前缀。
    return `- [${date}] ${content}`;
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

/** 把"人物底色"区块放回（放在第一个分类位置，保持固定顺序）。 */

/* ---------- 关系变量（好感度 / 亲密度） ---------- */

function clampInt(n: number, min: number, max: number): number {
  return Math.min(Math.max(Math.round(n), min), max);
}

export interface RelationValues {
  affinity: number;
  intimacy: number;
  mood: number;
  /** 信任：坦白/依赖/守约；爽约或敷衍会掉 */
  trust: number;
  /** 尊重：被贬低/被当工具使唤会掉 */
  respect: number;
  /** 心动：亲密 + 表白/黏人/深夜深聊 */
  attraction: number;
}

function extractValue(text: string, re: RegExp): number | null {
  for (const line of text.split('\n')) {
    const m = line.match(re);
    if (m) return clampInt(Number(m[1]), 0, RELATION_MAX);
  }
  return null;
}

/** 解析好感度/亲密度/心情值/信任/尊重/心动（缺失时取默认值）。 */
export function parseRelationValues(text: string): RelationValues {
  return {
    affinity: extractValue(text, AFFINITY_VAL_RE) ?? AFFINITY_DEFAULT,
    intimacy: extractValue(text, INTIMACY_VAL_RE) ?? INTIMACY_DEFAULT,
    mood: extractValue(text, MOOD_VAL_RE) ?? MOOD_DEFAULT,
    trust: extractValue(text, TRUST_VAL_RE) ?? TRUST_DEFAULT,
    respect: extractValue(text, RESPECT_VAL_RE) ?? RESPECT_DEFAULT,
    attraction: extractValue(text, ATTRACTION_VAL_RE) ?? ATTRACTION_DEFAULT,
  };
}

/** 单日变化截断（保留兼容；新逻辑用 applyGradualChange）。 */

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
  // 5 轴里另外三轴（缺失时补默认值，旧记忆平滑迁移）
  setValueLine(section, TRUST_LINE_RE, '信任', values.trust ?? TRUST_DEFAULT);
  setValueLine(section, RESPECT_LINE_RE, '尊重', values.respect ?? RESPECT_DEFAULT);
  setValueLine(section, ATTRACTION_LINE_RE, '心动', values.attraction ?? ATTRACTION_DEFAULT);
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
    trust: vals.trust,
    respect: vals.respect,
    attraction: vals.attraction,
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
