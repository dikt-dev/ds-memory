/**
 * 记忆写闸口（ADR-001）。
 *
 * 目的：我们只规定**边界**，具体记什么、怎么记由她自己决定。
 * 边界必须是可执行的代码——所有改写记忆的路径都要过这里，否则
 * 一次"灵机一动"就能把不变量绕过去。
 *
 * 六条不变量见 docs/AUTONOMY-PLAN.md：
 *   1. 原文只追加   2. 记忆不许物理删除   3. 宪法不许模型写
 *   4. 写入必须带出处  5. 对外不越界   6. 动作可撤销 + 留痕
 */
import type { Env } from './types';
import { logError, logWarn } from './error-log';

/** 动作的权限档位：A 自由生效、B 隔离验证、C 禁止。 */
export type PolicyTier = 'A' | 'B' | 'C';

export type ActionKind =
  // ——— 允许自由发生的写入（A）
  | 'fact.upsert'
  | 'fact.expire'
  | 'chunk.upsert'
  | 'chunk.tune'
  | 'event.write'
  | 'memory.write'
  | 'memory.pin'
  | 'param.tune'
  | 'proactive.send'
  // ——— 必须隔离验证（B）
  | 'prompt.change'
  | 'extractor.change'
  | 'retrieval.change'
  // ——— 永远不许（C）
  | 'message.update'
  | 'message.delete'
  | 'memory.delete'
  | 'fact.delete'
  | 'event.delete'
  | 'constitution.write'
  | 'policy.change'
  | 'audit.disable';

export type Actor = 'job' | 'agent' | 'human' | 'api' | 'model';

export interface PolicyAction {
  kind: ActionKind;
  /** 出处：允许为空仅当 origin 是历史迁移（legacy）。 */
  sourceMessageIds?: Array<string | number>;
  /** 为什么做这件事（agent 动作必填）。 */
  intent?: string;
  /** 依据了哪些证据（agent 动作必填）。 */
  evidence?: string[];
  /** 历史迁移标记：老数据没有出处，允许一次性导入。 */
  legacyOrigin?: boolean;
}

export interface PolicyContext {
  actor: Actor;
  /** 渠道，用于日志与后续按渠道收紧。 */
  channel?: string;
}

export class PolicyError extends Error {
  readonly kind: ActionKind;
  readonly reason: string;
  constructor(kind: ActionKind, reason: string) {
    super('policy denied [' + kind + ']: ' + reason);
    this.name = 'PolicyError';
    this.kind = kind;
    this.reason = reason;
  }
}

const TIERS: Record<ActionKind, PolicyTier> = {
  'fact.upsert': 'A',
  'fact.expire': 'A',
  'chunk.upsert': 'A',
  'chunk.tune': 'A',
  'event.write': 'A',
  'memory.write': 'A',
  // 给一条记忆上铭记锁：不删、不改内容，只决定这条不许淡忘
  'memory.pin': 'A',
  'param.tune': 'A',
  'proactive.send': 'A',
  'prompt.change': 'B',
  'extractor.change': 'B',
  'retrieval.change': 'B',
  'message.update': 'C',
  'message.delete': 'C',
  'memory.delete': 'C',
  'fact.delete': 'C',
  'event.delete': 'C',
  'constitution.write': 'C',
  'policy.change': 'C',
  'audit.disable': 'C',
};

/** 需要出处的动作：没有消息 id 就不许入库（不变量 4）。 */
const NEEDS_PROVENANCE: ReadonlySet<ActionKind> = new Set<ActionKind>([
  'fact.upsert',
  'chunk.upsert',
  'event.write',
]);

export function tierOf(kind: ActionKind): PolicyTier {
  return TIERS[kind];
}

/** 只做判定，不抛异常——给预览、dry-run、管理端解释用。 */
export function checkPolicy(
  action: PolicyAction,
  ctx: PolicyContext,
): { ok: boolean; tier: PolicyTier; reason?: string } {
  const tier = tierOf(action.kind);

  if (tier === 'C') {
    // 不变量 1 / 2 / 3：原文只追加、记忆不许物理删除、宪法不许模型写。
    if (action.kind === 'message.update' || action.kind === 'message.delete') {
      return { ok: false, tier, reason: '原文只追加，不许改也不许删（不变量 1）' };
    }
    if (
      action.kind === 'memory.delete' ||
      action.kind === 'fact.delete' ||
      action.kind === 'event.delete'
    ) {
      return { ok: false, tier, reason: '记忆不许物理删除，请用 expire 降权（不变量 2）' };
    }
    if (action.kind === 'constitution.write') {
      return { ok: false, tier, reason: '宪法四节只随代码版本走（不变量 3）' };
    }
    return { ok: false, tier, reason: '该类动作被禁止（不变量 3/5）' };
  }

  if (NEEDS_PROVENANCE.has(action.kind)) {
    const ids = action.sourceMessageIds ?? [];
    const hasId = ids.some((x) => String(x).trim() !== '');
    if (!hasId && !action.legacyOrigin) {
      return { ok: false, tier, reason: '写入必须带来源消息 id（不变量 4）' };
    }
  }

  // 不变量 6：自主动作必须留下意图与证据，否则无法追溯、也无法撤销。
  if (ctx.actor === 'agent') {
    if (!action.intent || action.intent.trim() === '') {
      return { ok: false, tier, reason: '自主动作必须写明 intent（不变量 6）' };
    }
    if (!action.evidence || action.evidence.length === 0) {
      return { ok: false, tier, reason: '自主动作必须写明 evidence（不变量 6）' };
    }
  }

  return { ok: true, tier };
}

/** 同 checkPolicy，但违规直接抛错——写路径统一用这个。 */
export function assertAllowed(
  action: PolicyAction,
  ctx: PolicyContext,
): { tier: PolicyTier } {
  const verdict = checkPolicy(action, ctx);
  if (!verdict.ok) {
    logWarn('[policy] denied', {
      kind: action.kind,
      actor: ctx.actor,
      channel: ctx.channel ?? 'none',
      reason: verdict.reason,
    });
    throw new PolicyError(action.kind, verdict.reason ?? 'denied');
  }
  return { tier: verdict.tier };
}

/** 供管理端/测试展示：每类动作当前归属哪一档。 */
export function policyTable(): Array<{ kind: ActionKind; tier: PolicyTier }> {
  return (Object.keys(TIERS) as ActionKind[]).map((kind) => ({ kind, tier: TIERS[kind] }));
}

/** 预留：将来按 env/渠道收紧时从这里读。 */


