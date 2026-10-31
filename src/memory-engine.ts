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
import { recordEngineMetric } from './engine-metrics';
import { recordRecallSample } from './recall-samples';
import { packMemoryChunks } from './context-packer';
import { loadMemoryChunks } from './memory-context-store';
import { expandLinkedChunks, expansionBudget } from './memory-links';
import { formatMemoryChunks, rankMemoryChunks, shouldRecallMemory } from './memory-domain';
import { CANDIDATE_TOP_K, embedTexts, recallMemoryForChat } from './memory-index';
import { selectRecall } from './recall-intent';
import { byteLength } from './memory-maintenance';
import { logTrace } from './trace';

/**
 * 整条召回的时间预算。超时就当没召回——空召回是合法降级，卡住不是。
 *
 * 2026-10-31 校准到 3000ms：实测（10-27 171ms → 10-29 503ms → 10-31 1190ms）
 * 随索引增长接近线性，1500ms 只剩 300ms 余量，一次抖动就整条作废。
 * 现在 legacy 与 next 并行，预算是 max 而不是 sum。
 */
export const RECALL_DEADLINE_MS = 3500;

/**
 * 输出封顶：条数与每条字数。借鉴 dsh-fish 的"回忆不是读档"。
 *
 * 2026-10-31 从 8 降到 5：近一周 new_items 几乎每次都顶满 8，
 * 说明是上限在替排序做筛选。少给几条、让每条都有理由，比塞满更接近"想起来"。
 */
export const RECALL_MAX_ITEMS = 5;
export const RECALL_ITEM_CHARS = 200;

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
  nowMs?: number;
  deadlineMs?: number;
}

export interface RecallResult {
  /** 最终该进提示词的文本（已封顶） */
  text: string;
  legacyText: string;
  nextText: string;
  skipped: boolean;
  timedOut: boolean;
  ms: number;
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
  embed: number;
  expand: number;
}

/** 跑新引擎：关键词优先，弱召回才补向量，再扩关联、打包、格式化。 */
async function runNextEngine(
  env: Env,
  query: string,
  focus: string,
): Promise<{
  text: string;
  items: number;
  dropped: number;
  linked: number;
  hasVector: boolean;
  intents: string[];
  picked: number;
  stages: NextStageMs;
}> {
  const stages: NextStageMs = { load: 0, rank: 0, embed: 0, expand: 0 };

  // 分段计时：延迟要按段优化，先得知道哪段贵（见 recall-samples.ts）。
  let t = performance.now();
  const chunks = await loadMemoryChunks(env);
  stages.load = performance.now() - t;
  if (chunks.length === 0) {
    return {
      text: '',
      items: 0,
      dropped: 0,
      linked: 0,
      hasVector: false,
      intents: [],
      picked: 0,
      stages,
    };
  }

  t = performance.now();
  // 粗召回放宽到 20 条：选择器要在一个较大的池子里挑，而不是在 6 条里挑 5 条。
  const keywordPicked = rankMemoryChunks(query, chunks, CANDIDATE_TOP_K, focus);
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
      ? rankMemoryChunks(query, chunks, CANDIDATE_TOP_K, focus, { queryVec })
      : keywordPicked;
  stages.rank += performance.now() - t;

  // 一次调用同时做「想清楚要找什么」和「挑哪几条」；失败就退回确定性排序。
  t = performance.now();
  let picked = pool.slice(0, RECALL_MAX_ITEMS);
  let selection: Awaited<ReturnType<typeof selectRecall>> = null;
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
  stages.rank += performance.now() - t;

  // 保底：候选里若有「进行中的事项」且已选中至少一条，就保证它进上下文。
  // 她答应过的事被忘了，是用户最不能接受的一类遗忘。
  if (picked.length > 0) {
    const hasOngoing = picked.some((chunk) => chunk.section === '进行中的事项');
    const ongoing = pool.find((chunk) => chunk.section === '进行中的事项');
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
): Promise<Awaited<ReturnType<typeof runNextEngine>>> {
  const empty = emptyNext();
  return withDeadline(runNextEngine(env, query, focus), deadlineMs, empty, onTimeout).catch(
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
    stages: { load: 0, rank: 0, embed: 0, expand: 0 },
  };
}

/** 查询向量：失败就当没有，退回纯关键词。 */
async function embedFor(env: Env, query: string): Promise<number[] | null> {
  const vecs = await embedTexts(env, [query]).catch(() => []);
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
  };

  // P2-5：门控现在对**所有**引擎生效。一句"你好"不该触发全量召回。
  if (!shouldRecallMemory(query)) {
    logTrace('memory.engine.skip', { requestId, engine: opts.mode, reason: 'low_signal_query' });
    result.skipped = true;
    result.ms = Math.round(performance.now() - started);
    return result;
  }

  const legacyStart = performance.now();
  const legacyPromise = withDeadline(
    recallMemoryForChat(env, query, undefined, focus, {
      skipMemorySource: opts.skipMemorySource,
    }).catch(() => ''),
    deadlineMs,
    '',
    () => {
      result.timedOut = true;
    },
  );

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
  const [legacyRaw, next] = await Promise.all([
    legacyPromise,
    runNextEngineSafe(env, engineQuery, focus, deadlineMs, () => {
      result.timedOut = true;
    }),
  ]);
  const legacyMs = performance.now() - legacyStart;
  result.legacyText = capRecallText(legacyRaw);

  let nextRaw = '';
  let stages: NextStageMs = { load: 0, rank: 0, embed: 0, expand: 0 };
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
      timedOut: result.timedOut,
    });
    await recordEngineMetric(env, {
      channel: opts.channel,
      kind,
      mode: opts.mode,
      oldItems,
      newItems: next.items,
      oldBytes: byteLength(result.legacyText),
      newBytes: byteLength(nextRaw),
      ms: Math.round(performance.now() - started),
      now: nowMs,
    });
    // 分段采样：聚合表看趋势，这里看分布（p50/p95）与各段占比。
    await recordRecallSample(env, {
      channel: opts.channel,
      mode: opts.mode,
      kind,
      legacyMs,
      loadMs: stages.load,
      rankMs: stages.rank,
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
    }, nowMs);
  } catch (e) {
    logTrace('memory.engine.error', {
      requestId,
      engine: opts.mode,
      message: e instanceof Error ? e.message : String(e),
    });
  }

  result.nextText = nextRaw;
  result.text = opts.mode === 'next' && nextRaw ? nextRaw : result.legacyText;
  result.ms = Math.round(performance.now() - started);
  return result;
}
