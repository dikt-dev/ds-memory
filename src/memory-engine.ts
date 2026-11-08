/**
 * memory-engine.ts —— 召回的统一入口。
 *
 * 这份文件是为了收掉三个问题（2026-10-30 评审）：
 *
 *   P1-5  chat.ts / openai.ts / webproactive.ts 各抄了一份 ~60 行的 shadow/next 分支，
 *         任何召回修复都要改三处，漏一处就是渠道间行为不一致。
 *   P1-1  整条召回串在首字路径上，却只有 llmRerank 那段有超时。
 *         D1/KV 一抖，延迟直接变成用户能感觉到的"卡住"。
 *   P2-5  shouldRecallMemory 只挡了 shadow/next，legacy 对一句"你好"照样全量召回。
 *
 * 现在所有渠道都走 resolveRecall()：先过门控，再带 deadline 跑 legacy，
 * 需要时再跑新引擎，最后统一做输出封顶与指标记录。
 */
import type { Env } from './types';
import { recordDegradation } from './degradations';
import { recordEngineMetric } from './engine-metrics';
import { recordRecallSample } from './recall-samples';
import { packMemoryChunks } from './context-packer';
import { loadMemoryChunks } from './memory-context-store';
import { expandLinkedChunks, expansionBudget } from './memory-links';
import {
  CORE_SECTIONS,
  formatMemoryChunks,
  rankMemoryChunks,
  querySubjectBias,
  shouldRecallMemory,
} from './memory-domain';
import { CANDIDATE_TOP_K, embedTexts, recallMemoryForChat } from './memory-index';
import { selectRecall } from './recall-intent';
import { byteLength } from './memory-maintenance';
import { logTrace } from './trace';
import { recordCpuSample } from './engine-metrics';

/**
 * 整条召回的时间预算。超时就当没召回——空召回是合法降级，卡住不是。
 *
 * 2026-10-31 校准到 3000ms：实测（10-27 171ms → 10-29 503ms → 10-31 1190ms）
 * 随索引增长接近线性，1500ms 只剩 300ms 余量，一次抖动就整条作废。
 * 现在 legacy 与 next 并行，预算是 max 而不是 sum。
 */
export const RECALL_DEADLINE_MS = 3500;

/** 分级召回的两个阈值：都按"已经花掉多少毫秒"判断，而不是等超时。 */
export const RECALL_SOFT_MS = 300;
export const RECALL_HARD_MS = 1500;

/**
 * 分段保底：超时不再等于空召回。
 *
 * - full：预算充足，正常走「粗召回 → 选择器 → 关联扩展」
 * - recent：只排最近 7 天，跳过选择器（一次 LLM 往返 0.5–1.5s，最贵）
 * - summary：只给核心层（人物底色/称呼关系/雷区/更正）——忘了细节也不能忘了她是谁
 */
export function recallTier(
  elapsedMs: number,
  softMs = RECALL_SOFT_MS,
  hardMs = RECALL_HARD_MS,
): 'full' | 'recent' | 'summary' {
  if (elapsedMs >= hardMs) return 'summary';
  if (elapsedMs >= softMs) return 'recent';
  return 'full';
}

/**
 * 输出封顶：条数与每条字数。借鉴 dsh-fish 的"回忆不是读档"。
 *
 * 2026-10-31 从 8 降到 5：近一周 new_items 几乎每次都顶满 8，
 * 说明是上限在替排序做筛选。少给几条、让每条都有理由，比塞满更接近"想起来"。
 */
export const RECALL_MAX_ITEMS = 5;
export const RECALL_ITEM_CHARS = 200;

/**
 * 覆盖率短路：候选正文已经在本轮注入的记忆里时，不算「没有想起来」。
 *
 * 为什么要有：chunk 的语料就是 memory.md 本身（见 memory-context-store.ts）。
 * 全量/分层注入时同一句话已经在提示词里，召回只可能把它再说一遍，
 * 却要付一次选择器模型往返（实测 1.3 s）。
 *
 * 关掉：RECALL_SKIP_COVERED=off（回退到旧行为，用于对比与救急）。
 */
const COVER_MIN_CHARS = 8;
const COVER_ANCHOR_CHARS = 24;

/** 这条候选是不是已经逐字（或按首句锚点）出现在本轮注入的记忆里。 */
export function isCovered(chunk: { content: string }, injected: string): boolean {
  const body = (chunk.content ?? '').trim();
  if (!injected || body.length < COVER_MIN_CHARS) return false;
  if (injected.includes(body)) return true;
  const anchor = body.slice(0, COVER_ANCHOR_CHARS);
  return anchor.length >= 12 && injected.includes(anchor);
}

/** 选择器的最小候选数：小于它时确定性排序已经够用。默认 4，可用 env 覆盖。 */
export const RECALL_SELECT_MIN_POOL = 4;
export function selectMinPool(env: { RECALL_SELECT_MIN_POOL?: string }): number {
  const raw = Number(env.RECALL_SELECT_MIN_POOL);
  return Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : RECALL_SELECT_MIN_POOL;
}

export type RecallMode = 'legacy' | 'shadow' | 'next';

export interface RecallOptions {
  query: string;
  /** 新引擎用的检索词；不给就用 query（主动消息里两者不同） */
  nextQuery?: string;
  focus?: string;
  mode: RecallMode;
  channel: string;
  requestId?: string;
  kind?: 'memory' | 'proactive';
  skipMemorySource?: boolean;
  /** 本轮将要注入提示词的核心记忆：已经在这里出现的候选不再召回 */
  injectedText?: string;
  nowMs?: number;
  deadlineMs?: number;
  /**
   * 把指标写盘挪到响应之后（Workers 的 waitUntil）。
   *
   * 不传就退化成 fire-and-forget：指标可以丢，但绝不能卡住回复。
   * 实测两次 D1 写占了召回 74~88ms 里的 ~70ms（2026-11-08）。
   */
  waitUntil?: (p: Promise<unknown>) => void;
}

export interface RecallResult {
  /** 最终该进提示词的文本（已封顶） */
  text: string;
  legacyText: string;
  nextText: string;
  skipped: boolean;
  timedOut: boolean;
  ms: number;
  /** 覆盖率诊断：候选总数里有多少已经被提示词覆盖、多少真的参与了召回 */
  covered?: number;
  uncovered?: number;
  selectorSkipped?: boolean;
  /** 本轮真正注入的 chunks id（复习计数用；legacy 链路拿不到，返回空）。 */
  ids: string[];
}

/**
 * 带 deadline 的等待。
 *
 * 注意：超时**不会**取消底层请求（Workers 里没有通用的取消语义），
 * 它只是让调用方先走。底层那次 KV/D1 读取仍会跑完，结果被丢弃。
 */
export async function withDeadline<T>(
  promise: Promise<T>,
  ms: number,
  fallback: T,
  onTimeout?: () => void,
): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return fallback;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      onTimeout?.();
      resolve(fallback);
    }, ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * 输出封顶：只留前 maxItems 条，每条截到 maxChars，多出来的折成一行。
 *
 * "翻不到就是翻不到"——不给她一整个索引，那等于把回忆变成读档。
 */
export function capRecallText(
  text: string,
  maxItems = RECALL_MAX_ITEMS,
  maxChars = RECALL_ITEM_CHARS,
): string {
  if (!text) return '';
  const lines = text.split('\n');
  const header = lines.filter((l) => !l.startsWith('- ')).join('\n');
  const items = lines.filter((l) => l.startsWith('- '));
  if (items.length <= maxItems) return text;

  const kept = items.slice(0, maxItems).map((line) => {
    const body = line.slice(2);
    return body.length > maxChars ? `- ${body.slice(0, maxChars)}…` : line;
  });
  const dropped = items.length - kept.length;
  return [...[header], ...kept, `- （还有 ${dropped} 条相关记忆没展开）`]
    .filter((l) => l.length > 0)
    .join('\n');
}

export interface NextStageMs {
  load: number;
  rank: number;
  /** 选择器：一次蒸馏模型往返。
   *  以前这段被累加进 rank，于是「排序要 1.3 秒」成了误判（2026-11-08 复盘）。 */
  select: number;
  embed: number;
  expand: number;
  /** rank 区间内子阶段实测之和（核对口径用） */
  rankInner?: number;
}

/** 跑新引擎：关键词优先，弱召回才补向量，再扩关联、打包、格式化。 */
async function runNextEngine(
  env: Env,
  query: string,
  focus: string,
  opts: { injectedText?: string; onStage?: (name: string, ms: number) => void } = {},
): Promise<{
  covered: number;
  uncovered: number;
  selectorSkipped: boolean;
  text: string;
  items: number;
  dropped: number;
  linked: number;
  hasVector: boolean;
  intents: string[];
  picked: number;
  stages: NextStageMs;
  tier: 'full' | 'recent' | 'summary';
  ids: string[];
}> {
  const onStage = opts.onStage;
  const stages: NextStageMs = { load: 0, rank: 0, select: 0, embed: 0, expand: 0, rankInner: 0 };
  const started = performance.now();

  // 分段计时：延迟要按段优化，先得知道哪段贵（见 recall-samples.ts）。
  let t = performance.now();
  const allChunks = await loadMemoryChunks(env);
  stages.load = performance.now() - t;

  // ★ 覆盖率短路（2026-11-08）：这一轮要注入的记忆里已经有的条目，不需要再「想起来」。
  //   现在的 chunk 语料就是 memory.md 本身，不短路等于把同一句话发两遍，还多付一次模型往返。
  const injected = (opts.injectedText ?? '').trim();
  const chunks = injected ? allChunks.filter((chunk) => !isCovered(chunk, injected)) : allChunks;
  const covered = allChunks.length - chunks.length;
  if (allChunks.length === 0 || (injected && allChunks.length > 0 && chunks.length === 0)) {
    if (injected && allChunks.length > 0) {
      logTrace('memory.recall.covered', { covered, uncovered: 0, skipped: true, loadMs: Math.round(stages.load) });
    }
    return {
      text: '',
      items: 0,
      dropped: 0,
      linked: 0,
      hasVector: false,
      intents: [],
      picked: 0,
      stages,
      tier: 'full' as const,
      ids: [],
      covered,
      uncovered: 0,
      selectorSkipped: injected.length > 0 && allChunks.length > 0,
    };
  }

  // 加载已经花掉太多预算：不再排序，直接给核心层。
  let tier = recallTier(performance.now() - started);
  if (tier === 'summary') {
    const floor = packMemoryChunks(
      chunks.filter((chunk) => CORE_SECTIONS.has(chunk.section)).slice(0, RECALL_MAX_ITEMS),
    );
    logTrace('memory.recall.tier', { tier, items: floor.chunks.length, loadMs: stages.load });
    return {
      text: formatMemoryChunks(floor.chunks),
      items: floor.chunks.length,
      dropped: floor.dropped,
      linked: 0,
      hasVector: false,
      intents: [],
      picked: floor.chunks.length,
      stages,
      tier,
      ids: floor.chunks.map((c) => c.id),
      covered,
      uncovered: chunks.length,
      selectorSkipped: false,
    };
  }

  // recent 档：只在最近 7 天里排，池子小一个数量级，纯关键词也够用。
  const poolSource = tier === 'recent' ? recentChunks(chunks, 7) : chunks;
  // 这一轮问的是谁的事：同主体的记忆排前面（「我那个项目」不该命中她的条目）
  const subjectBias = querySubjectBias(query);

  t = performance.now();
  // 粗召回放宽到 20 条：选择器要在一个较大的池子里挑，而不是在 6 条里挑 5 条。
  const innerStage = (name: string, ms: number) => {
    stages.rankInner = (stages.rankInner ?? 0) + ms;
    onStage?.(name, ms);
  };
  const keywordPicked = rankMemoryChunks(query, poolSource, CANDIDATE_TOP_K, focus, { onStage: innerStage, subjectBias });
  stages.rank = performance.now() - t;

  // 关键词已经够强时不再付 query embedding 延迟；弱召回才走向量。
  const hasVectors = chunks.some((chunk) => Boolean(chunk.vec));
  let queryVec: number[] | null = null;
  if (hasVectors && keywordPicked.length < 3) {
    t = performance.now();
    queryVec = (await embedFor(env, query)) ?? null;
    stages.embed = performance.now() - t;
  }

  t = performance.now();
  const pool =
    queryVec !== null
      ? rankMemoryChunks(query, poolSource, CANDIDATE_TOP_K, focus, { queryVec, onStage: innerStage, subjectBias })
      : keywordPicked;
  stages.rank += performance.now() - t;

  // 排序后再看一次预算：这时还在软阈值内才有资格付选择器的 LLM 往返。
  tier = recallTier(performance.now() - started);

  // 一次调用同时做「想清楚要找什么」和「挑哪几条」；失败就退回确定性排序。
  t = performance.now();
  let picked = pool.slice(0, RECALL_MAX_ITEMS);
  let selection: Awaited<ReturnType<typeof selectRecall>> = null;
  // 候选太少时确定性排序已经够用；只有真的要「挑」的时候才值得付一次模型往返。
  if (tier === 'full' && chunks.length >= selectMinPool(env)) {
    selection = await selectRecall(env, {
      query,
      focus,
      candidates: pool.map((chunk) => ({
        id: chunk.id,
        date: chunk.date,
        content: chunk.content,
        section: chunk.section,
      })),
      maxPick: RECALL_MAX_ITEMS,
    }).catch(() => null);
  }
  if (selection) {
    const byId = new Map(pool.map((chunk) => [chunk.id, chunk]));
    const chosen = selection.pickedIds
      .map((id) => byId.get(id))
      .filter((chunk): chunk is (typeof pool)[number] => Boolean(chunk));
    // 模型明确说「一条都不该提」时就真的不放：宁缺毋滥。
    picked = chosen;
    logTrace('memory.intents', {
      intents: selection.intents,
      picked: chosen.length,
      candidates: pool.length,
      ms: selection.ms,
      backend: selection.backend,
    });
  }
  // 这一段是选择器的往返时间，单独记，别混进排序
  stages.select += performance.now() - t;

  // 保底：候选里若有「进行中的事」且已选中至少一条，就保证它进上下文。
  // 她答应过的事被忘了，是用户最不能接受的一类遗忘。
  if (picked.length > 0) {
    const hasOngoing = picked.some((chunk) => chunk.section === '进行中的事');
    const ongoing = pool.find((chunk) => chunk.section === '进行中的事');
    if (!hasOngoing && ongoing) {
      picked = [...picked.slice(0, Math.max(0, RECALL_MAX_ITEMS - 1)), ongoing];
    }
  }

  t = performance.now();
  const expanded = await expandLinkedChunks(env, picked, expansionBudget(picked.length));
  stages.expand = performance.now() - t;

  const packed = packMemoryChunks(expanded);
  return {
    text: formatMemoryChunks(packed.chunks),
    items: packed.chunks.length,
    dropped: packed.dropped,
    linked: expanded.length - picked.length,
    hasVector: queryVec !== null,
    intents: selection?.intents ?? [],
    picked: picked.length,
    stages,
    tier,
    ids: packed.chunks.map((c) => c.id),
    covered,
    uncovered: chunks.length,
    // 走到这里说明没有因为覆盖率短路；候选太少没调选择器是另一回事，别混成一个指标
    selectorSkipped: false,
  };
}

/**
 * 并行版 next 引擎：带自己的 deadline、自己的兜底。
 *
 * 和 legacy 同时起跑，超时或抛错都只影响这一侧，不拖累另一侧。
 */
async function runNextEngineSafe(
  env: Env,
  query: string,
  focus: string,
  deadlineMs: number,
  onTimeout: () => void,
  opts: { injectedText?: string; onStage?: (name: string, ms: number) => void } = {},
): Promise<Awaited<ReturnType<typeof runNextEngine>>> {
  const empty = emptyNext();
  return withDeadline(runNextEngine(env, query, focus, opts), deadlineMs, empty, onTimeout).catch(
    () => empty,
  );
}

/** 空结果（超时/报错时的兜底），单独提出来避免每处重复。 */
function emptyNext(): Awaited<ReturnType<typeof runNextEngine>> {
  return {
    text: '',
    items: 0,
    dropped: 0,
    linked: 0,
    hasVector: false,
    intents: [],
    picked: 0,
    stages: { load: 0, rank: 0, select: 0, embed: 0, expand: 0 },
    tier: 'full' as const,
    ids: [],
    covered: 0,
    uncovered: 0,
    selectorSkipped: false,
  };
}

/** 最近 N 天的 chunks；太旧的不进 recent 档（全空时退回全量，宁可慢一点也别空）。 */
function recentChunks(
  chunks: Awaited<ReturnType<typeof loadMemoryChunks>>,
  days: number,
): Awaited<ReturnType<typeof loadMemoryChunks>> {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const recent = chunks.filter((chunk) => (chunk.date ?? '') >= cutoff);
  return recent.length > 0 ? recent : chunks;
}

/** 查询向量：失败就当没有，退回纯关键词。 */
async function embedFor(env: Env, query: string): Promise<number[] | null> {
  const vecs = await embedTexts(env, [query]).catch(() => {
    void recordDegradation(env, 'embed').catch(() => {});
    return [];
  });
  return vecs[0] ?? null;
}

/**
 * 所有渠道的唯一召回入口。
 *
 * 顺序：门控 → legacy（带 deadline）→ 新引擎（剩余预算）→ 封顶 → 指标。
 */
export async function resolveRecall(env: Env, opts: RecallOptions): Promise<RecallResult> {
  const started = performance.now();
  const nowMs = opts.nowMs ?? Date.now();
  // 指标写盘不阻塞回复：有 waitUntil 就交给它，没有就 fire-and-forget
  const flush = opts.waitUntil ?? ((p: Promise<unknown>) => { void p; });
  const deadlineMs = opts.deadlineMs ?? RECALL_DEADLINE_MS;
  const requestId = opts.requestId ?? 'none';
  const kind = opts.kind ?? 'memory';
  const query = opts.query ?? '';
  const focus = opts.focus ?? '';

  const result: RecallResult = {
    text: '',
    legacyText: '',
    nextText: '',
    skipped: false,
    timedOut: false,
    ms: 0,
    ids: [],
  };

  // P2-5：门控现在对**所有**引擎生效。一句"你好"不该触发全量召回。
  if (!shouldRecallMemory(query)) {
    logTrace('memory.engine.skip', { requestId, engine: opts.mode, reason: 'low_signal_query' });
    result.skipped = true;
    result.ms = Math.round(performance.now() - started);
    return result;
  }

  // 'next' 模式不再并行跑 legacy：那条链路要扫全表做 BM25 + 向量打分，
  // 只为指标留着它等于白烧一份 CPU。只有 shadow 才需要两边都有。
  const needLegacy = opts.mode !== 'next';
  const legacyStart = performance.now();
  const legacyPromise = needLegacy
    ? withDeadline(
        recallMemoryForChat(env, query, undefined, focus, {
          skipMemorySource: opts.skipMemorySource,
        }).catch(() => ''),
        deadlineMs,
        '',
        () => {
          result.timedOut = true;
        },
      )
    : Promise.resolve('');

  if (opts.mode === 'legacy') {
    const legacyRaw = await legacyPromise;
    result.legacyText = capRecallText(legacyRaw);
    result.text = result.legacyText;
    result.ms = Math.round(performance.now() - started);
    return result;
  }

  // ★ 两段并行。串行时延迟是 legacy + next（实测 708ms + 482ms = 1190ms），
  //   并行后是 max(legacy, next)。shadow / next 都要跑两套，必须并行。
  const engineQuery = (opts.nextQuery ?? '').trim() || query;
  // 覆盖率短路默认开；RECALL_SKIP_COVERED=off 可一键回退（对比、救急都用它）
  const injectedText = env.RECALL_SKIP_COVERED === 'off' ? undefined : opts.injectedText;
  const [legacyRaw, next] = await Promise.all([
    legacyPromise,
    runNextEngineSafe(env, engineQuery, focus, deadlineMs, () => {
      result.timedOut = true;
    }, {
      injectedText,
      onStage: (name, ms) => {
        // 子阶段耗时：排查 rank 到底花在哪（rank_kw / rank_vec / rank_mmr）
        void recordCpuSample(env, opts.channel, name, ms).catch(() => {});
      },
    }),
  ]);
  // next 模式不跑 legacy：这里必须记 0，否则会因为 Promise.all 等到 next 结束
  // 而把「并行的等待时间」记成 legacy 的耗时，指标会一直骗人。
  const legacyMs = needLegacy ? performance.now() - legacyStart : 0;
  result.legacyText = capRecallText(legacyRaw);

  let nextRaw = '';
  let stages: NextStageMs = { load: 0, rank: 0, select: 0, embed: 0, expand: 0 };
  let nextItems = 0;
  let nextLinked = 0;
  let nextHasVector = false;
  let nextPicked = 0;
  try {
    nextRaw = capRecallText(next.text);
    stages = next.stages;
    // 记「封顶之后」的条数：pack 出来的 8 条会被 capRecallText 裁到 5，
    // 记未裁的数字会让指标看起来永远顶满，误导判断。
    nextItems = nextRaw
      .split('\n')
      .filter((line) => line.startsWith('- ') && !line.includes('条相关记忆没展开')).length;
    nextLinked = next.linked;
    nextHasVector = next.hasVector;
    nextPicked = next.picked;
    result.covered = next.covered;
    result.uncovered = next.uncovered;
    result.selectorSkipped = next.selectorSkipped;
    // 选择器耗时单独上报：它才是召回里最贵的一段
    void recordCpuSample(env, opts.channel, 'select_ms', stages.select).catch(() => {});

    const oldItems = result.legacyText.split('\n').filter((l) => l.startsWith('- ')).length;
    logTrace('memory.engine', {
      requestId,
      engine: opts.mode,
      oldItems,
      nextItems: next.items,
      oldBytes: byteLength(result.legacyText),
      nextBytes: byteLength(nextRaw),
      packedDropped: next.dropped,
      linkedItems: next.linked,
      hasVector: next.hasVector,
      shadowMs: Math.round(performance.now() - started),
      selectMs: Math.round(stages.select),
      timedOut: result.timedOut,
      tier: next.tier,
    });
    flush(recordEngineMetric(env, {
      channel: opts.channel,
      kind,
      mode: opts.mode,
      oldItems,
      newItems: next.items,
      oldBytes: byteLength(result.legacyText),
      newBytes: byteLength(nextRaw),
      ms: Math.round(performance.now() - started),
      now: nowMs,
    }).catch(() => {}));
    // 分段采样：聚合表看趋势，这里看分布（p50/p95）与各段占比。
    flush(recordRecallSample(env, {
      channel: opts.channel,
      mode: opts.mode,
      kind,
      legacyMs,
      loadMs: stages.load,
      rankMs: stages.rank,
      rankInnerMs: stages.rankInner ?? 0,
      selectMs: stages.select,
      embedMs: stages.embed,
      expandMs: stages.expand,
      totalMs: performance.now() - started,
      items: nextItems,
      linked: nextLinked,
      hasVector: nextHasVector,
      timedOut: result.timedOut,
      // 旧侧「受限于只允许 archive 来源且没有任何命中」——不是「没跑」。
      // 注意：skipMemorySource 只是过滤掉 memory 来源，legacy 仍会读行/排序/可能 embed，
      // 所以这一位为 1 时 legacy_ms 仍然可能是几百毫秒。old_items=0 别直接读成「旧召回差」。
      legacySkipped: opts.skipMemorySource === true && result.legacyText.trim() === '',
      intents: next.intents,
      picked: nextPicked,
      covered: next.covered,
      uncovered: next.uncovered,
      selectorSkipped: next.selectorSkipped,
    }, nowMs).catch(() => {}));
  } catch (e) {
    logTrace('memory.engine.error', {
      requestId,
      engine: opts.mode,
      message: e instanceof Error ? e.message : String(e),
    });
  }

  result.nextText = nextRaw;
  // 注入的就是 packed 里那几条：复习计数按它们记。
  result.ids = next.ids;
  result.text = opts.mode === 'next' && nextRaw ? nextRaw : result.legacyText;
  result.ms = Math.round(performance.now() - started);
  return result;
}
