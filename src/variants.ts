/**
 * B 档变体：隔离验证后自动裁决（ADR-001 S10）。
 *
 * 她可以提议改自己的提示词、抽取规则、召回策略——但这些改动一律先躺在
 * "待验证"，由**离线评估集**跑出对比数据，赢了才允许上线，输了自动回滚。
 *
 * 关键：裁决不看她自己说得多好听，只看指标。
 */
import type { Env } from './types';
import { recordAction } from './memory-actions';
import { assertAllowed, type ActionKind } from './policy';

export type VariantKind = 'prompt' | 'extractor' | 'retrieval';
export type VariantStatus = 'pending' | 'active' | 'rolled_back' | 'rejected';

export interface VariantMetrics {
  samples: number;
  hitRate: number;
  avgItems: number;
  falsePositiveRate: number;
}

export interface Variant {
  id: string;
  kind: VariantKind;
  target: string;
  change: string;
  intent: string;
  evidence: string[];
  status: VariantStatus;
  createdAt: number;
  decidedAt?: number;
  baseline?: VariantMetrics;
  candidate?: VariantMetrics;
  decision?: string;
}

export const VARIANTS_KEY = 'memory:variants';
const MAX_VARIANTS = 30;
const MIN_SAMPLES = 20;

const KIND_TO_ACTION: Record<VariantKind, ActionKind> = {
  prompt: 'prompt.change',
  extractor: 'extractor.change',
  retrieval: 'retrieval.change',
};

export function actionForKind(kind: VariantKind): ActionKind {
  return KIND_TO_ACTION[kind];
}

function pct(v: number): string {
  return (v * 100).toFixed(1);
}

/** 是否值得把候选留下：命中率要涨，且不能靠少注入或乱召回来凑。 */
export function decideVariant(
  baseline: VariantMetrics,
  candidate: VariantMetrics,
  opts: { minGain?: number; maxFalsePositiveRise?: number } = {},
): { keep: boolean; reason: string } {
  const minGain = opts.minGain ?? 0.02;
  const maxFpRise = opts.maxFalsePositiveRise ?? 0.01;

  if (candidate.samples < MIN_SAMPLES || baseline.samples < MIN_SAMPLES) {
    return {
      keep: false,
      reason: '样本不足（基线 ' + baseline.samples + ' / 候选 ' + candidate.samples + '，至少 ' + MIN_SAMPLES + '）',
    };
  }
  const gain = candidate.hitRate - baseline.hitRate;
  const fpRise = candidate.falsePositiveRate - baseline.falsePositiveRate;
  if (fpRise > maxFpRise) {
    return { keep: false, reason: '误召率上升 ' + pct(fpRise) + ' 个百分点，超阈值' };
  }
  if (candidate.avgItems > baseline.avgItems + 1) {
    return { keep: false, reason: '靠多塞条目换命中率，不算改进' };
  }
  if (gain < minGain) {
    return {
      keep: false,
      reason: '命中率只提升 ' + pct(gain) + ' 个百分点，低于 ' + pct(minGain) + ' 的阈值',
    };
  }
  return { keep: true, reason: '命中率 +' + pct(gain) + ' 个百分点，误召与注入量未恶化' };
}

export async function loadVariants(env: Env): Promise<Variant[]> {
  try {
    const raw = await env.KV.get(VARIANTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Variant[]) : [];
  } catch {
    return [];
  }
}

async function saveVariants(env: Env, variants: Variant[]): Promise<void> {
  await env.KV.put(VARIANTS_KEY, JSON.stringify(variants.slice(0, MAX_VARIANTS)));
}

export function newVariant(
  input: {
    kind: VariantKind;
    target: string;
    change: string;
    intent: string;
    evidence: string[];
  },
  now = Date.now(),
): Variant {
  return {
    id: 'var_' + now.toString(36) + '_' + Math.random().toString(36).slice(2, 6),
    kind: input.kind,
    target: input.target.trim(),
    change: input.change.trim().slice(0, 2000),
    intent: input.intent.trim().slice(0, 500),
    evidence: input.evidence.map((e) => String(e)).slice(0, 10),
    status: 'pending',
    createdAt: now,
  };
}

/** 提交一个候选（B 档动作：必须过 policy，且只登记不上线）。 */
export async function proposeVariant(
  env: Env,
  input: Parameters<typeof newVariant>[0],
  now = Date.now(),
): Promise<Variant> {
  const action = actionForKind(input.kind);
  assertAllowed(
    { kind: action, intent: input.intent, evidence: input.evidence },
    { actor: 'agent', channel: 'self-review' },
  );
  const variant = newVariant(input, now);
  const variants = await loadVariants(env);
  await saveVariants(env, [variant, ...variants]);
  await recordAction(env, {
    actor: 'agent',
    kind: action,
    intent: input.intent,
    evidence: input.evidence,
    diff: (input.kind + ': ' + input.target + ' —— ' + input.change).slice(0, 1000),
    before: '当前线上版本',
    after: '待验证（未生效）',
    revertible: true,
  }, now).catch(() => {});
  return variant;
}

/** 用评估数据裁决：赢了标 active，输了标 rejected。 */
export async function decideById(
  env: Env,
  id: string,
  baseline: VariantMetrics,
  candidate: VariantMetrics,
  now = Date.now(),
): Promise<{ ok: boolean; variant?: Variant; reason: string }> {
  const variants = await loadVariants(env);
  const variant = variants.find((v) => v.id === id);
  if (!variant) return { ok: false, reason: 'variant not found' };
  if (variant.status !== 'pending') return { ok: false, reason: 'variant already decided' };

  const verdict = decideVariant(baseline, candidate);
  variant.baseline = baseline;
  variant.candidate = candidate;
  variant.decision = verdict.reason;
  variant.status = verdict.keep ? 'active' : 'rejected';
  variant.decidedAt = now;
  await saveVariants(env, variants);
  await recordAction(env, {
    actor: 'job',
    kind: actionForKind(variant.kind),
    intent: verdict.reason,
    evidence: ['baseline:' + baseline.samples, 'candidate:' + candidate.samples],
    diff: variant.target + ': ' + (verdict.keep ? '保留' : '拒绝'),
    before: '命中率 ' + pct(baseline.hitRate) + '%',
    after: '命中率 ' + pct(candidate.hitRate) + '%',
    revertible: true,
  }, now).catch(() => {});
  return { ok: true, variant, reason: verdict.reason };
}

/** 回滚：把已上线的变体退回，并记录原因。 */
export async function rollbackVariant(
  env: Env,
  id: string,
  reason: string,
  now = Date.now(),
): Promise<boolean> {
  const variants = await loadVariants(env);
  const variant = variants.find((v) => v.id === id);
  if (!variant || variant.status !== 'active') return false;
  variant.status = 'rolled_back';
  variant.decidedAt = now;
  variant.decision = '回滚：' + reason;
  await saveVariants(env, variants);
  await recordAction(env, {
    actor: 'agent',
    kind: actionForKind(variant.kind),
    intent: '指标恶化或人工判定，回滚变体',
    evidence: [reason],
    diff: variant.target + ' 回滚',
    before: 'active',
    after: 'rolled_back',
    revertible: false,
  }, now).catch(() => {});
  return true;
}
