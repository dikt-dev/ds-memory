/**
 * 置信度与证据门（ADR-001 S5）。
 *
 * 两条规则，都是为了"没有人能手动修正"这个前提：
 * 1. **证据门**：模型给的引文在原文里找不到，这条记忆就是编的，不许入库；
 * 2. **置信度只随人变**：她自己重复不能变可信，只有用户确认/纠正才动分数。
 */
import type { MemoryFact } from './memory-domain';

/** 事实来源：决定初始置信度。 */
export type FactSource = 'conversation' | 'memory' | 'correction' | 'inference';

const BASE: Record<FactSource, number> = {
  // 对话里抽出来的：可能有误读，起点低
  conversation: 0.6,
  // memory.md 是人写的记录
  memory: 0.85,
  // 用户明确纠正过的话，优先级最高
  correction: 0.95,
  // 模型推断，不进事实库，仅用于排序参考
  inference: 0.4,
};

export const MIN_CONFIDENCE = 0.2;
export const LOW_TRUST_THRESHOLD = 0.5;

export type ConfidenceSignal =
  | 'user_confirm'
  | 'user_correct'
  | 'repeat'
  | 'decay';

const DELTA: Record<ConfidenceSignal, number> = {
  // 用户亲口确认（"对，就是这样"）
  user_confirm: 0.15,
  // 用户纠正过：这条以后再出现也只能是低可信
  user_correct: -0.35,
  // 她自己又提了一次——不加分，只防止被误衰减
  repeat: 0.02,
  decay: -0.05,
};

function clamp(value: number): number {
  if (!Number.isFinite(value)) return MIN_CONFIDENCE;
  return Math.min(1, Math.max(MIN_CONFIDENCE, Math.round(value * 100) / 100));
}

export function confidenceForSource(source: FactSource): number {
  return clamp(BASE[source] ?? 0.5);
}

/** 应用一个信号；模型推断永远不能提高置信度（不传 signal 即不动）。 */
export function applySignal(current: number, signal: ConfidenceSignal): number {
  return clamp(current + (DELTA[signal] ?? 0));
}

export function isLowTrust(confidence: number): boolean {
  return confidence < LOW_TRUST_THRESHOLD;
}

/** 给注入用的短语：让"不确定"的说法在措辞上就能体现出来。 */
export function confidenceTag(confidence: number): string {
  if (confidence >= 0.85) return '确定';
  if (confidence >= LOW_TRUST_THRESHOLD) return '较可信';
  return '存疑';
}

/**
 * 证据门：模型说它引用了 N 句原文，实际能对上的只有 M 句。
 * 一句都对不上 = 整条事件是编的，直接丢掉；丢掉一部分就只保留对上的。
 */
export interface QuoteGateResult {
  ok: boolean;
  kept: string[];
  dropped: number;
  /** 一句话都没对上：视为编造。 */
  fabricated: boolean;
}

export function quoteGate(proposed: string[], valid: string[]): QuoteGateResult {
  const asked = proposed.filter((q) => (q ?? '').trim().length > 0);
  const kept = valid.filter((q) => (q ?? '').trim().length > 0);
  const dropped = Math.max(0, asked.length - kept.length);
  const fabricated = asked.length > 0 && kept.length === 0;
  return { ok: !fabricated, kept, dropped, fabricated };
}

/** 同一事实重复出现时合并置信度：取较高者，并按 repeat 轻微上浮。 */
export function mergeConfidence(existing: number, incoming: number): number {
  const base = Math.max(existing, incoming);
  return clamp(base + DELTA.repeat);
}

/** 用户纠正后，被纠正的事实要永久降权（即使之后被重复提及）。 */
export function penalizeCorrected(fact: Pick<MemoryFact, 'confidence'>): number {
  return applySignal(fact.confidence, 'user_correct');
}
