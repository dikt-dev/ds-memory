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
import { expandLinkedChunks } from './memory-links';
import { formatMemoryChunks, rankMemoryChunks, shouldRecallMemory } from './memory-domain';
import { embedTexts, recallMemoryForChat } from './memory-index';
import { byteLength } from './memory-maintenance';
import { logTrace } from './trace';

/**
 * 整条召回的时间预算。超时就当没召回——空召回是合法降级，卡住不是。
 *
 * 2026-10-30 按实测校准：shadow 路径（只跑新引擎，不含 legacy）的平均耗时
 * 10-27 171ms → 10-28 345ms → 10-29 503ms，随索引增长接近线性上升。
 * 800ms 在 legacy + 新引擎串行时几乎必然撞线，所以放宽到 1500ms。
 */
export const RECALL_DEADLINE_MS = 1500;

/** 输出封顶：条数与每条字数。借鉴 dsh-fish 的"回忆不是读档"。 */
export const RECALL_MAX_ITEMS = 8;
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
  stages: NextStageMs;
}> {
  const stages: NextStageMs = { load: 0, rank: 0, embed: 0, expand: 0 };

  // 分段计时：延迟要按段优化，先得知道哪段贵（见 recall-samples.ts）。
  let t = performance.now();
  const chunks = await loadMemoryChunks(env);
  stages.load = performance.now() - t;
  if (chunks.length === 0) {
    return { text: '', items: 0, dropped: 0, linked: 0, hasVector: false, stages };
  }

  t = performance.now();
  const keywordPicked = rankMemoryChunks(query, chunks, 6, focus);
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
  const picked =
    queryVec !== null ? rankMemoryChunks(query, chunks, 6, focus, { queryVec }) : keywordPicked;
  stages.rank += performance.now() - t;

  t = performance.now();
  const expanded = await expandLinkedChunks(env, picked, 2);
  stages.expand = performance.now() - t;

  const packed = packMemoryChunks(expanded);
  return {
    text: formatMemoryChunks(packed.chunks),
    items: packed.chunks.length,
    dropped: packed.dropped,
    linked: expanded.length - picked.length,
    hasVector: queryVec !== null,
    stages,
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
  const legacyRaw = await withDeadline(
    recallMemoryForChat(env, query, undefined, focus, {
      skipMemorySource: opts.skipMemorySource,
    }).catch(() => ''),
    deadlineMs,
    '',
    () => {
      result.timedOut = true;
    },
  );
  const legacyMs = performance.now() - legacyStart;
  result.legacyText = capRecallText(legacyRaw);

  if (opts.mode === 'legacy' || result.timedOut) {
    result.text = result.legacyText;
    result.ms = Math.round(performance.now() - started);
    return result;
  }

  const remaining = Math.max(1, deadlineMs - (performance.now() - started));
  const engineQuery = (opts.nextQuery ?? '').trim() || query;
  let nextRaw = '';
  let stages: NextStageMs = { load: 0, rank: 0, embed: 0, expand: 0 };
  let nextItems = 0;
  let nextLinked = 0;
  let nextHasVector = false;
  try {
    const next = await withDeadline(
      runNextEngine(env, engineQuery, focus),
      remaining,
      {
        text: '',
        items: 0,
        dropped: 0,
        linked: 0,
        hasVector: false,
        stages: { load: 0, rank: 0, embed: 0, expand: 0 },
      },
      () => {
        result.timedOut = true;
      },
    );
    nextRaw = capRecallText(next.text);
    stages = next.stages;
    nextItems = next.items;
    nextLinked = next.linked;
    nextHasVector = next.hasVector;

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
