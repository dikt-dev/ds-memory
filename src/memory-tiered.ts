/**
 * 分层记忆（tiered）：稳定事实常驻 + 事件按时间窗口内联，更早的只走召回。
 *
 * 为什么不是纯按时间：`职业=上班族` 这类事实不会因为"写得早"而失效，
 * 一刀切会把最该记住的东西切出去（2026-11-06 的线上事故）。
 *
 * 分层：
 *   L0 宪法：人物底色 / 称呼与关系 / 他的雷区 / 他的更正 —— 永远内联
 *   L1 事实：关于他 / 他的偏好 —— 永远内联
 *   L2 事件：共同经历 / 你的生活 / 近期动态 / [已完成] 的事项 —— 只带最近 N 天
 *   L3 其余：不进提示词，靠召回
 */

const ALWAYS_SECTIONS = new Set([
  '他的更正（最高优先级）',
  '人物底色',
  '称呼与关系',
  '他的雷区',
  '关于他',
  '他的偏好',
]);

/** 事件类分区：里面的条目按日期过滤。 */
const EVENT_SECTIONS = new Set(['共同经历', '你的生活', '近期动态', '进行中的事']);

const DATE_RE = /^-\s*\[(\d{2}|\d{4})-(\d{1,2})-(\d{1,2})\]/;
const DONE_RE = /\[已完成\]/;

export interface TieredOptions {
  /** 事件窗口（天），默认 60。 */
  days?: number;
  /** 内联硬上限（字节）。超了从最旧的事件条目开始裁。 */
  maxBytes?: number;
  now?: Date;
}

export interface TieredStats {
  bytes: number;
  entries: number;
  droppedByAge: number;
  droppedByBudget: number;
}

interface Section {
  name: string;
  lines: string[];
}

const encoder = new TextEncoder();
export const byteLen = (s: string): number => encoder.encode(s).length;

/** 北京时间的 YYYY-MM-DD。 */
function dayKey(d: Date): string {
  return new Date(d.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
}

function parseDate(line: string): string | null {
  const m = DATE_RE.exec(line.trim());
  if (!m) return null;
  const year = m[1].length === 2 ? `20${m[1]}` : m[1];
  return `${year}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
}

function splitSections(text: string): Section[] {
  const out: Section[] = [];
  let cur: Section | null = null;
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) {
      if (cur) out.push(cur);
      cur = { name: m[1].trim(), lines: [] };
    } else if (cur) {
      cur.lines.push(line);
    }
  }
  if (cur) out.push(cur);
  return out;
}

function render(sections: Section[]): string {
  return sections
    .map((s) => {
      const body = s.lines
        .filter((l) => !/^\s*<!--/.test(l))
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      return body ? `## ${s.name}\n${body}` : '';
    })
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

/**
 * 过滤 + 预算裁剪。
 *
 * 无日期的条目一律保留（键=值 事实没有日期）；
 * 「进行中的事」里 [进行中] / [搁置] 保留，[已完成] 按事件窗口处理。
 */
export function extractTieredMemory(
  text: string,
  opts: TieredOptions = {},
): { text: string; stats: TieredStats } {
  const days = Math.max(1, opts.days ?? 60);
  const maxBytes = opts.maxBytes ?? 16 * 1024;
  const cutoff = dayKey(new Date((opts.now ?? new Date()).getTime() - days * 86400_000));

  let droppedByAge = 0;
  const kept: Section[] = [];
  for (const section of splitSections(text)) {
    const always = ALWAYS_SECTIONS.has(section.name);
    const isEvent = EVENT_SECTIONS.has(section.name);
    const lines: string[] = [];
    for (const line of section.lines) {
      const trimmed = line.trim();
      if (!trimmed) { lines.push(''); continue; }
      if (/^\s*<!--/.test(trimmed)) continue;
      if (always) { lines.push(line); continue; }
      if (!isEvent) { lines.push(line); continue; }
      const date = parseDate(trimmed);
      // 无日期的事件条目：宁可留下，也不误杀
      if (!date) { lines.push(line); continue; }
      const done = DONE_RE.test(trimmed);
      const isOngoing = section.name === '进行中的事' && !done;
      if (isOngoing || date >= cutoff) { lines.push(line); continue; }
      droppedByAge += 1;
    }
    kept.push({ name: section.name, lines });
  }

  let out = render(kept);

  // 预算：只裁事件条目，L0/L1 不动
  let droppedByBudget = 0;
  while (byteLen(out) > maxBytes) {
    let oldestSection = -1;
    let oldestLine = -1;
    let oldestDate = '';
    for (let i = 0; i < kept.length; i += 1) {
      const s = kept[i];
      if (ALWAYS_SECTIONS.has(s.name) || !EVENT_SECTIONS.has(s.name)) continue;
      for (let j = 0; j < s.lines.length; j += 1) {
        const d = parseDate(s.lines[j]);
        if (!d) continue;
        if (!oldestDate || d < oldestDate) { oldestDate = d; oldestSection = i; oldestLine = j; }
      }
    }
    if (oldestSection < 0) break; // 没得裁了
    kept[oldestSection].lines.splice(oldestLine, 1);
    droppedByBudget += 1;
    out = render(kept);
  }

  return {
    text: out,
    stats: {
      bytes: byteLen(out),
      entries: out.split('\n').filter((l) => l.trim().startsWith('- ')).length,
      droppedByAge,
      droppedByBudget,
    },
  };
}
