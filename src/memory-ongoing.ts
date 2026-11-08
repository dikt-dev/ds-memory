/**
 * 「进行中的事」合并过期状态行。
 *
 * 问题：一件事被拖过几轮，记忆里就会留下
 *   [搁置] 回滚方案草稿：用户多次拖延…助手催了多轮
 *   [进行中] 待 11-01 解冻实施
 *   [已完成] 回滚落地了
 * 她读到的是全部历史，于是对一件早就做完的事反复追问「核过没有」。
 *
 * 这里做的是**同主题只留最新一条**：按最长公共子串把行归堆，
 * 每堆留下「日期最新 + 状态最靠后」的那条，其余进 R2 档案层（不直接销毁）。
 * 只动「进行中的事」这一节，别的不碰。
 */

import { clusterByEntity } from './memory-compact';

/** 状态优先级：越靠后越「新」。 */
const STATUS_RANK: Array<[RegExp, number]> = [
  [/\[已完成\]/, 4],
  [/\[进行中\]/, 3],
  [/\[搁置\]/, 1],
];

/** 只由这些词组成的公共子串不能当「同一件事」的判据。 */
const STOP = new Set(['用户', '助手', '今天', '明天', '这个', '那个', '可以', '什么', '已经', '还是']);

function longestCommonSubstring(a: string, b: string): string {
  const A = [...a];
  const B = [...b];
  let best = '';
  let prev = new Array(B.length + 1).fill(0);
  for (let i = 1; i <= A.length; i += 1) {
    const cur = new Array(B.length + 1).fill(0);
    for (let j = 1; j <= B.length; j += 1) {
      if (A[i - 1] === B[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > best.length) best = A.slice(i - cur[j], i).join('');
      }
    }
    prev = cur;
  }
  return best;
}

function lineDate(line: string): string {
  const m = line.match(/\[(\d{2}-\d{2}-\d{2})\]/);
  return m ? m[1] : '';
}

function statusRank(line: string): number {
  for (const [re, rank] of STATUS_RANK) if (re.test(line)) return rank;
  return 2;
}

/** 去掉日期、状态标记和项目符号——它们每条都一样，拿来比只会全部误判成同一件事。 */
function core(line: string): string {
  return line
    .replace(/^-\s*/, '')
    .replace(/\[\d{2}-\d{2}-\d{2}\]/, '')
    .replace(/\[(已完成|进行中|搁置)\]/g, '')
    .trim();
}

/**
 * 同一件事的判据：去掉日期/状态后，有一段 ≥3 字、不是泛词、
 * 且占较短那条一半以上的公共子串。
 *
 * 只看绝对长度会误判：「- [26-10-2」这种前缀人人都有。
 */
/** 主题名：句首到第一个标点为止（「回滚方案草稿：用户多次拖延…」→「回滚方案草稿」）。 */
function title(line: string): string {
  const c = core(line);
  const cut = c.split(/[：:，,。；;]/)[0].trim();
  return (cut || c).slice(0, 14);
}

export function sameTopic(a: string, b: string): boolean {
  const ta = title(a);
  const tb = title(b);
  if (ta.length < 3 || tb.length < 3) return false;
  if (ta === tb) return true;
  if (ta.includes(tb) || tb.includes(ta)) return true;
  const lcs = longestCommonSubstring(ta, tb);
  if (lcs.length < 3 || STOP.has(lcs)) return false;
  return lcs.length / Math.min(ta.length, tb.length) >= 0.6;
}

export interface CollapseResult {
  text: string;
  /** 被移走的行（调用方负责归档） */
  removed: string[];
  /** 保留下来、被判定为「同一件事」的组 */
  groups: string[][];
}

/**
 * 合并「## 进行中的事」里同主题的旧行。
 *
 * 除「已完成」外，同一组最多留 1 条；「已完成」的行保留（它是结论，不该被旧行覆盖）。
 */
export function collapseOngoing(text: string, opts: { maxRemove?: number } = {}): CollapseResult {
  const header = '## 进行中的事';
  const lines = text.split('\n');
  const head = lines.findIndex((l) => l.trim() === header);
  if (head < 0) return { text, removed: [], groups: [] };
  let tail = lines.findIndex((l, i) => i > head && l.startsWith('## '));
  if (tail < 0) tail = lines.length;

  const body = lines.slice(head + 1, tail);
  // 只处理以「- 」开头、带日期标记的行；空行和别的文字原样保留
  const idxMap: number[] = [];
  const entries: string[] = [];
  body.forEach((l, i) => {
    if (/^- \[\d{2}-\d{2}-\d{2}\]/.test(l.trim())) {
      idxMap.push(i);
      entries.push(l.trim());
    }
  });
  if (entries.length < 2) return { text, removed: [], groups: [] };

  // 并查集归堆
  const parent = entries.map((_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      if (sameTopic(entries[i], entries[j])) union(i, j);
    }
  }
  // ★ 再按「实体」归一次（2026-11-08）：标题前缀判据对真实措辞常常一个都不命中，
  //   例如「他填完转正自评表」和「他的转正流程」只共 2 个字，恒不成立。
  //   entityClusters 用的是「本节里真实重复出现的片段」，能把同一件事的几个版本收拢。
  const entity = clusterByEntity(entries);
  for (const cluster of entity.clusters) {
    for (let i = 1; i < cluster.length; i += 1) union(cluster[0], cluster[i]);
  }

  const buckets = new Map<number, number[]>();
  entries.forEach((_, i) => {
    const r = find(i);
    const list = buckets.get(r) ?? [];
    list.push(i);
    buckets.set(r, list);
  });

  const drop = new Set<number>();
  const groups: string[][] = [];
  for (const list of buckets.values()) {
    if (list.length < 2) continue;
    groups.push(list.map((i) => entries[i]));
    const sorted = [...list].sort((a, b) => {
      const d = lineDate(entries[b]).localeCompare(lineDate(entries[a]));
      if (d !== 0) return d;
      return statusRank(entries[b]) - statusRank(entries[a]);
    });
    const keep = sorted[0];
    for (const i of list) {
      if (i === keep) continue;
      // 已经标了 [已完成] 的旧行不删：它是结论，留着比删掉安全
      if (/\[已完成\]/.test(entries[i])) continue;
      drop.add(i);
    }
    // 不把旧版本的细节拼回保留条：进行中的事本来就是「状态」，
    // 旧版本的进展（用户多次拖延、催了几轮）留着只会让她反复追问。
    // 被并掉的行由调用方归档到 R2，需要时还能查。
  }

  const maxRemove = opts.maxRemove ?? 5;
  const dropped = [...drop].slice(0, maxRemove);
  if (dropped.length === 0) return { text, removed: [], groups };

  const outBody = body.filter((_, i) => !dropped.some((d) => idxMap[d] === i));
  const removed = dropped.map((d) => entries[d]);
  const next = [...lines.slice(0, head + 1), ...outBody, ...lines.slice(tail)].join('\n');
  return { text: next, removed, groups };
}

/**
 * 晾太久的「进行中」降级成「挂起」。
 *
 * 为什么需要：她每天读这些条目，会对着两周没动的事反复追问进度
 * （用户：「回滚那个事不是早做完了吗，你怎么老问」）。
 * 与其指望每天有人手动清理，不如让时间自己降级。
 *
 * 两条豁免：
 *   1. 已经有明确未来日期的（下月/预计/下周…）——那是真的在等，不是忘了
 *   2. 带 [已完成] / [挂起] 的
 */
const FUTURE_HINT = /下月|下周|明年|预计|之后|回头|等.{0,3}(再说|再看|做完)/;

function lineDateKey(line: string): string | null {
  const m = line.match(/^\s*- \[(\d{2})-(\d{2})-(\d{2})\]/);
  if (!m) return null;
  return `20${m[1]}-${m[2]}-${m[3]}`;
}

export function suspendStaleOngoing(text: string, todayKey: string, days = 7): {
  text: string;
  suspended: string[];
} {
  const today = Date.parse(todayKey + 'T00:00:00Z');
  const suspended: string[] = [];
  const out = text.split('\n').map((line) => {
    if (!line.includes('[进行中]')) return line;
    if (FUTURE_HINT.test(line)) return line;
    const key = lineDateKey(line);
    if (!key) return line;
    const age = (today - Date.parse(key + 'T00:00:00Z')) / 86400000;
    if (!Number.isFinite(age) || age <= days) return line;
    suspended.push(line.trim());
    return line.replace('[进行中]', '[挂起]');
  });
  return { text: out.join('\n'), suspended };
}
