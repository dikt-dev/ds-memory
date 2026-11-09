/**
 * 分层上下文预算。
 *
 * 固定记忆（memory.md 核心）永远保留；
 * 近期摘要、周/月 rollup、召回片段按优先级装填；
 * 超预算时先裁召回，再裁 rollup，最后裁近期摘要。
 */

export type ContextBlockName = 'core' | 'recent' | 'recentMemo' | 'recall';

export interface ContextBudgetInput {
  core: string;
  recent?: string;
  /** 中期记忆（最近几天）。以前叫 rollup，但它装的从来不是周/月汇总 */
  recentMemo?: string;
  recall?: string;
  /** 非核心块总预算；核心记忆不计入这个预算。 */
  maxChars?: number;
  /** 核心记忆自身的安全上限；默认 12k。 */
  coreMaxChars?: number;
}

export interface ContextBlockManifest {
  name: ContextBlockName;
  originalChars: number;
  includedChars: number;
  droppedChars: number;
  truncated: boolean;
}

export interface ContextBudgetResult {
  core: string;
  recent: string;
  recentMemo: string;
  recall: string;
  totalChars: number;
  maxChars: number;
  manifest: ContextBlockManifest[];
}

const DEFAULT_MAX_CHARS = 10_000;
const DEFAULT_CORE_MAX_CHARS = 12_000;
const RECENT_CAP = 2_200;
const ROLLUP_CAP = 2_200;
const RECALL_CAP = 4_000;

function clean(value: string | undefined): string {
  return (value ?? '').trim();
}

function clip(value: string, maxChars: number): { text: string; truncated: boolean } {
  if (maxChars <= 0) return { text: '', truncated: value.length > 0 };
  if (value.length <= maxChars) return { text: value, truncated: false };
  // 保留开头和结尾，避免只留下开场白。
  const head = Math.max(1, Math.ceil(maxChars * 0.75));
  const tail = Math.max(0, maxChars - head - 1);
  return {
    text: `${value.slice(0, head)}…${tail > 0 ? value.slice(-tail) : ''}`,
    truncated: true,
  };
}

function block(
  name: ContextBlockName,
  original: string,
  included: string,
  truncated: boolean,
): ContextBlockManifest {
  return {
    name,
    originalChars: original.length,
    includedChars: included.length,
    droppedChars: Math.max(0, original.length - included.length),
    truncated,
  };
}

/**
 * 装填顺序：core → recent → rollup → recall。
 * core 使用自己的上限，不占用 recent/rollup/recall 的预算；
 * 非核心预算不足时 recall 先被截断。
 */
export function budgetContext(input: ContextBudgetInput): ContextBudgetResult {
  const coreRaw = clean(input.core);
  const recentRaw = clean(input.recent);
  const recentMemoRaw = clean(input.recentMemo);
  const recallRaw = clean(input.recall);
  const maxChars = Math.max(0, Math.floor(input.maxChars ?? DEFAULT_MAX_CHARS));
  const coreMaxChars = Math.max(
    0,
    Math.floor(input.coreMaxChars ?? DEFAULT_CORE_MAX_CHARS),
  );

  const coreClip = clip(coreRaw, coreMaxChars);
  const core = coreClip.text;
  const entries: ContextBlockManifest[] = [
    block('core', coreRaw, core, coreClip.truncated),
  ];
  let remaining = maxChars;

  const recentTake = Math.min(recentRaw.length, RECENT_CAP, remaining);
  const recent = clip(recentRaw, recentTake);
  entries.push(block('recent', recentRaw, recent.text, recent.truncated));
  remaining = Math.max(0, remaining - recent.text.length);

  const memoTake = Math.min(recentMemoRaw.length, ROLLUP_CAP, remaining);
  const recentMemo = clip(recentMemoRaw, memoTake);
  entries.push(block('recentMemo', recentMemoRaw, recentMemo.text, recentMemo.truncated));
  remaining = Math.max(0, remaining - recentMemo.text.length);

  const recallTake = Math.min(recallRaw.length, RECALL_CAP, remaining);
  const recall = clip(recallRaw, recallTake);
  entries.push(block('recall', recallRaw, recall.text, recall.truncated));

  return {
    core,
    recent: recent.text,
    recentMemo: recentMemo.text,
    recall: recall.text,
    totalChars: entries.reduce((sum, e) => sum + e.includedChars, 0),
    maxChars,
    manifest: entries,
  };
}

/**
 * 只算「核心记忆」这一段的裁剪结果。
 *
 * 召回要判断「这条是不是已经在提示词里」，必须和真正注入的那段逐字一致；
 * 用同一个 clip 才能保证口径不分叉（budgetContext 内部也走它）。
 */
export function clipCore(text: string, coreMaxChars = DEFAULT_CORE_MAX_CHARS): string {
  return clip(clean(text), Math.max(0, Math.floor(coreMaxChars))).text;
}

export function formatBudgetManifest(manifest: ContextBlockManifest[]): string {
  return manifest
    .map(
      (m) =>
        `${m.name}:${m.includedChars}/${m.originalChars}${m.truncated ? '(trimmed)' : ''}`,
    )
    .join(', ');
}
