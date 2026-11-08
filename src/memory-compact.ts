/**
 * 同一实体的多个版本折叠成一个（2026-11-08）。
 *
 * 为什么需要：memory-ongoing.ts 早就有一套「同主题只留最新一条」，判据是
 * 「标题取到第一个标点 + 最长公共子串占较短标题 60%」。线上真实数据下它一次都没命中：
 *
 *   他填完转正自评表        ← 转正第 1 版
 *   他的转正流程            ← 转正第 2 版（公共子串只有「转正」2 字，低于 3 字阈值）
 *   他给自己聊天 app 加页面  ← app 第 1 版
 *   他给聊天 app 修 bug      ← app 第 2 版（前缀被截断，LCS 占比 0.45，低于 0.6）
 *   他的聊天 app 新加页面    ← app 第 3 版
 *
 * 所以换一个判据：同一节里按「语料里真实重复出现的词」当实体键，
 * 而不是靠人工词表或标题前缀。出现在 2 条以上、又没多到遍布全节的片段，
 * 就是这一节里「同一件事」的证据（转正 / app / 自评表 / 剥虾…）。
 *
 * 只做纯函数：不读写存储，调用方决定要不要写回。
 */

/** 状态标记：折叠时它们决定留哪条，也该从实体键里剔除。 */
const STATUS_TOKENS = /\[(已完成|进行中|搁置|已搁置)\]/g;
/** 日期前缀。 */
const DATE_PREFIX = /^\[\d{2,4}-\d{2}-\d{2}\]\s*/;
/** 条目符号。 */
const BULLET = /^-\s*/;

/** 不作为实体键的片段：代词、常见动词开头、时间词。 */
const STOP_FRAGMENTS = new Set([
  '他的', '你的', '我的', '他给', '你给', '我说', '他说', '你说', '我给',
  '今天', '昨天', '明天', '前天', '后天', '早上', '中午', '晚上', '凌晨',
  '已经', '还是', '可以', '什么', '这个', '那个', '一下', '一直', '因为', '所以',
  '但是', '然后', '而且', '现在', '时候', '一点', '有点', '起来', '出来',
  '自己', '我们', '他们', '一起', '之后', '之前', '这次', '那次', '结果',
  // 记忆主语只用「他 / 你 / 一起」（AGENTS.md）：用户/助手 是历史遗留写法，不能当实体键
  '用户', '助手', '她们', '咱们', '一遍', '两次', '三次', '好多', '特别',
]);

/** 去日期、状态、条目符号，留下「这条在说什么」。 */
export function entryCore(line: string): string {
  return (line || '').replace(BULLET, '').replace(DATE_PREFIX, '').replace(STATUS_TOKENS, '').trim();
}

/** 从一条记忆里取出「可能当实体键的片段」：ASCII 词 + 中文 2~4 字子串。 */
export function candidateFragments(core: string): string[] {
  const out: string[] = [];
  const lower = (core || '').toLowerCase();
  for (const m of lower.matchAll(/[a-z][a-z0-9]{1,}/g)) out.push(m[0]);
  for (const m of lower.matchAll(/[\u4e00-\u9fa5]{2,}/g)) {
    const run = m[0];
    for (let len = 2; len <= 4; len += 1) {
      for (let i = 0; i + len <= run.length; i += 1) out.push(run.slice(i, i + len));
    }
  }
  return [...new Set(out)];
}

export interface EntityClusterResult {
  /** 每个簇：至少 2 条，下标升序 */
  clusters: number[][];
  /** 被认定为实体键的片段（诊断用） */
  keys: string[];
}

/**
 * 把一组条目按实体聚成簇。
 *
 * 判据：某片段出现在 ≥2 条、且不超过全组的一半（太常见就不是实体，是口水话），
 * 两条共享这样的片段就算同一件事；连通分量即为一簇。
 */
export function clusterByEntity(
  lines: string[],
  opts: { maxShare?: number; minLines?: number } = {},
): EntityClusterResult {
  const n = lines.length;
  if (n < 2) return { clusters: [], keys: [] };
  const maxShare = opts.maxShare ?? 0.5;
  const minLines = opts.minLines ?? 2;

  const cores = lines.map(entryCore);
  const frags = cores.map(candidateFragments);

  const df = new Map<string, number[]>();
  frags.forEach((list, idx) => {
    for (const f of list) {
      const arr = df.get(f);
      if (arr) {
        if (arr[arr.length - 1] !== idx) arr.push(idx);
      } else df.set(f, [idx]);
    }
  });

  const keep: string[] = [];
  for (const [frag, idxs] of df) {
    if (idxs.length < minLines) continue;
    if (idxs.length > Math.max(2, Math.floor(n * maxShare))) continue;
    if (STOP_FRAGMENTS.has(frag)) continue;
    if (/^\d+$/.test(frag)) continue;
    // 中文片段只认「两条之间的重复」：中文用词太灵活，出现三次以上的片段多半是
    // 「自己」「页面」这类口水词，拿它当实体会把不同的事串成一簇。
    // ASCII 实体（app / bug / ui）不受这个限制，它们才是稳定标识。
    const ascii = /^[a-z0-9]+$/.test(frag);
    if (!ascii && idxs.length > 2) continue;
    keep.push(frag);
  }
  // 只留最长的那批：'聊天app' 覆盖 '聊天'，避免一个实体被拆成两簇
  const keys = keep.filter((k) => !keep.some((other) => other !== k && other.includes(k)));

  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  for (const key of keys) {
    const idxs = df.get(key) ?? [];
    for (let i = 1; i < idxs.length; i += 1) union(idxs[0], idxs[i]);
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i += 1) {
    const root = find(i);
    const arr = groups.get(root);
    if (arr) arr.push(i);
    else groups.set(root, [i]);
  }
  const clusters = [...groups.values()].filter((g) => g.length >= 2);
  return { clusters, keys };
}

/** 条目日期（YY-MM-DD 或 YYYY-MM-DD），没有返回空串。 */
export function entryDate(line: string): string {
  const m = (line || '').match(/\[(\d{2,4}-\d{2}-\d{2})\]/);
  return m ? m[1] : '';
}

/** 状态优先级：已有结论的排前面（已完成 > 进行中 > 搁置 > 无标记）。 */
function statusRank(line: string): number {
  if (/\[已完成\]/.test(line)) return 4;
  if (/\[进行中\]/.test(line)) return 3;
  if (/\[搁置\]/.test(line) || /\[已搁置\]/.test(line)) return 1;
  return 2;
}

/** 把旧条目里「保留条没提到」的从句拼一句，避免折叠时丢细节。 */
export function mergeDetail(keeper: string, older: string, maxChars = 60): string {
  // 已经很长就不再往里塞：折叠是为了让她好读，不是把三条黏成一条。
  if (keeper.length > 160) return keeper;
  const clauses = entryCore(older)
    .split(/[，,。；;]/)
    .map((c) => c.trim())
    .filter((c) => c.length >= 4);
  const extra: string[] = [];
  for (const clause of clauses) {
    if (keeper.includes(clause)) continue;
    extra.push(clause);
    if (extra.join('；').length >= maxChars) break;
  }
  if (extra.length === 0) return keeper;
  let tail = extra.join('；');
  if (tail.length > maxChars) tail = tail.slice(0, maxChars - 1) + '…';
  return keeper + '（另：' + tail + '）';
}

export interface FoldResult {
  /** 折叠后的行（顺序不变，被并掉的置空） */
  lines: string[];
  /** 被并掉的行（调用方负责备份/归档） */
  removed: string[];
  /** 每个被折叠的簇保留的那一条 */
  kept: string[];
}

/**
 * 就地折叠：每簇留「日期最新 + 状态最靠后」的一条，其余移出并把独有细节并进去。
 *
 * 保守原则：拿不准的簇不并——宁可留两条，也不要错并成一件。
 * 宪法四节由调用方保证不会传进来。
 */
export function foldClusters(lines: string[], result: EntityClusterResult): FoldResult {
  const out = [...lines];
  const removed: string[] = [];
  const kept: string[] = [];
  for (const cluster of result.clusters) {
    const ranked = [...cluster].sort((a, b) => {
      const da = entryDate(lines[a]);
      const db = entryDate(lines[b]);
      if (da !== db) return db.localeCompare(da);
      return statusRank(lines[b]) - statusRank(lines[a]);
    });
    const keepIdx = ranked[0];
    let keeper = lines[keepIdx];
    for (const idx of ranked.slice(1)) {
      keeper = mergeDetail(keeper, lines[idx]);
      out[idx] = '';
      removed.push(lines[idx]);
    }
    out[keepIdx] = keeper;
    kept.push(keeper);
  }
  return { lines: out, removed, kept };
}

/** 宪法分区：只读，任何折叠都不许碰。 */
export const CONSTITUTION_SECTIONS = ['人物底色', '他的雷区', '称呼与关系'];

interface RawSection { header: string; name: string; lines: string[] }

function splitRawSections(memory: string): { pre: string; sections: RawSection[] } {
  const pre: string[] = [];
  const sections: RawSection[] = [];
  let cur: RawSection | null = null;
  for (const line of (memory || '').split('\n')) {
    const m = /^##\s+(.*)$/.exec(line);
    if (m) {
      cur = { header: '## ' + m[1].trim(), name: m[1].trim(), lines: [] };
      sections.push(cur);
      continue;
    }
    if (cur) cur.lines.push(line);
    else pre.push(line);
  }
  return { pre: pre.join('\n'), sections };
}

function joinRawSections(pre: string, sections: RawSection[]): string {
  // 每节去掉尾部空行再拼：否则每跑一次就多一行空行，不是幂等的（实测过一次）。
  const blocks = sections.map((s) => {
    const lines = [...s.lines];
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
    while (lines.length > 0 && lines[0].trim() === '') lines.shift();
    return [s.header, ...lines].join('\n');
  });
  const body = blocks.join('\n\n');
  const head = pre.trim() ? pre.trimEnd() + '\n\n' : '';
  return head + body + (body ? '\n' : '');
}

function bigramSet(text: string): Set<string> {
  const out = new Set<string>();
  const t = entryCore(text).replace(/\s+/g, '').toLowerCase();
  for (let i = 0; i + 1 < t.length; i += 1) out.add(t.slice(i, i + 2));
  return out;
}

function asciiTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of entryCore(text).toLowerCase().matchAll(/[a-z][a-z0-9]{1,}/g)) out.add(m[0]);
  return out;
}

/**
 * 两条记忆是不是在说同一件事。
 *
 * 用在跨分区去重上（承诺 vs 事件、共同经历 vs 近期动态）：
 * 共享 ASCII 实体词 → 算；bigram 重合度高 → 算。
 * 比分区内的实体聚类更保守，避免把「回上海」和「回滚」并掉。
 */

/** 最长公共子串（按字符）。跨分区判重时要求 ≥6 字，比 bigram 更能抓住「同一句事实」。 */
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
export function sameEvent(a: string, b: string): boolean {
  if (!a || !b) return false;
  const ta = asciiTokens(a);
  for (const tok of asciiTokens(b)) if (ta.has(tok)) return true;
  const ga = bigramSet(a);
  const gb = bigramSet(b);
  if (ga.size === 0 || gb.size === 0) return false;
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter += 1;
  const union = ga.size + gb.size - inter;
  if (union > 0 && inter / union >= 0.35) return true;
  if (inter / Math.min(ga.size, gb.size) >= 0.6) return true;
  // 一整段事实逐字重合（≥6 字）：剥虾约定 vs 剥虾约定升级 就是这种
  return longestCommonSubstring(entryCore(a), entryCore(b)).length >= 6;
}

export interface CrossSectionResult {
  text: string;
  /** 被移出的行（调用方负责归档） */
  removed: string[];
  /** 承诺区里被事件区重复记录、于是从句里删掉的条数 */
  promiseDuplicates: number;
  /** 近期动态里与共同经历重复、被删掉的条数 */
  recentDuplicates: number;
}

/**
 * 跨分区去重（2026-11-08）。
 *
 * 两条明确的规则：
 *   1. 「答应过的事」优先：同一条约定在「进行中的事 / 共同经历」里也出现 → 删事件区那条。
 *      承诺只留一处，否则她自己也不知道该按哪个说法答。
 *   2. 「近期动态」与「共同经历」重复时保留共同经历：
 *      近期动态是最近几天的临时展台，长期事实该留在共同经历里。
 *
 * 宪法三节（人物底色 / 他的雷区 / 称呼与关系）完全不参与。
 */
export function crossSectionPass(memory: string): CrossSectionResult {
  const { pre, sections } = splitRawSections(memory);
  const removed: string[] = [];
  let promiseDuplicates = 0;
  let recentDuplicates = 0;

  const find = (name: string) => sections.find((s) => s.name === name);
  const promises = find('答应过的事');
  const ongoing = find('进行中的事');
  const shared = find('共同经历');
  const recent = find('近期动态');
  const promiseLines = (promises?.lines ?? []).filter((l) => /^- \[/.test(l.trim()));

  // 规则 1：承诺优先
  if (promiseLines.length > 0) {
    for (const sec of [ongoing, shared]) {
      if (!sec) continue;
      sec.lines = sec.lines.filter((line) => {
        if (!/^- \[/.test(line.trim())) return true;
        const dup = promiseLines.some((p) => sameEvent(p, line));
        if (!dup) return true;
        removed.push(line);
        promiseDuplicates += 1;
        return false;
      });
    }
  }

  // 规则 2：共同经历优先于近期动态
  if (shared && recent) {
    const sharedLines = shared.lines.filter((l) => /^- \[/.test(l.trim()));
    recent.lines = recent.lines.filter((line) => {
      if (!/^- \[/.test(line.trim())) return true;
      const dup = sharedLines.some((s) => sameEvent(s, line));
      if (!dup) return true;
      removed.push(line);
      recentDuplicates += 1;
      return false;
    });
  }

  return {
    text: joinRawSections(pre, sections),
    removed,
    promiseDuplicates,
    recentDuplicates,
  };
}

/** 宪法三节的内容必须原样保留（折叠前后比对用）。 */
export function constitutionBlocks(memory: string): string[] {
  const { sections } = splitRawSections(memory);
  return sections
    .filter((s) => CONSTITUTION_SECTIONS.includes(s.name))
    .map((s) => s.lines.join('\n').replace(/\s+/g, ''));
}
