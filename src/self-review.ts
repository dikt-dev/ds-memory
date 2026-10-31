/**
 * 自审 agent（ADR-001 S9，只开 A 档）。
 *
 * 这是她第一次自己决定"记忆该怎么改"。所有权力都被这三道闸约束：
 * 1. 只允许 A 档动作（改派生层：chunk 重要度、合并重复片段），B/C 档写了也不执行；
 * 2. 每个动作必须带 intent + evidence，且过一次 policy 闸口；
 * 3. 动作数有上限、全部进审计表、可撤销。
 *
 * 判据仍然来自外部（健康分、自检报告、召回 miss），不是她自己打分。
 */
import type { Env } from './types';
import { distillText } from './distill';
import { addLlmCost } from './llm-cost';
import { dateKeyInBeijing } from './date';
import { assertAllowed, tierOf, type ActionKind } from './policy';
import { recordAction } from './memory-actions';
import { loadHealth } from './health';
import { runSelfCheck } from './self-check';
import { putObject } from './storage';

/** 她可以自己做的动作：只碰派生层，不碰原文/宪法/事实内容。 */
export const SELF_REVIEW_ALLOWED: ActionKind[] = [
  'chunk.tune',
  'param.tune',
  'fact.expire',
];

export interface Proposal {
  kind: string;
  /** 改哪个对象（chunk id / fact id / 参数名）。 */
  target: string;
  /** 为什么改。 */
  intent: string;
  /** 依据（指标名、样本 id、消息 id）。 */
  evidence: string[];
  /** 改成什么（数值或简短描述）。 */
  value: string;
}

export interface ReviewVerdict {
  accepted: Proposal[];
  rejected: Array<Proposal & { reason: string }>;
}

const MAX_PROPOSALS = 8;
const MAX_ACCEPTED = 5;

/** 只保留可执行、可审计的提案；其余原样退回并写明原因。 */
export function vetProposals(proposals: Proposal[]): ReviewVerdict {
  const accepted: Proposal[] = [];
  const rejected: Array<Proposal & { reason: string }> = [];
  for (const raw of proposals.slice(0, MAX_PROPOSALS)) {
    const proposal: Proposal = {
      kind: String(raw.kind ?? '').trim(),
      target: String(raw.target ?? '').trim(),
      intent: String(raw.intent ?? '').trim(),
      evidence: Array.isArray(raw.evidence) ? raw.evidence.map((e) => String(e)) : [],
      value: String(raw.value ?? '').trim(),
    };
    const kind = proposal.kind as ActionKind;
    if (!SELF_REVIEW_ALLOWED.includes(kind)) {
      rejected.push({ ...proposal, reason: `动作 ${proposal.kind} 不在 A 档白名单里（当前只放 chunk.tune / param.tune / fact.expire）` });
      continue;
    }
    if (tierOf(kind) !== 'A') {
      rejected.push({ ...proposal, reason: `动作 ${kind} 属于 ${tierOf(kind)} 档` });
      continue;
    }
    if (!proposal.target) {
      rejected.push({ ...proposal, reason: '缺少 target' });
      continue;
    }
    if (!proposal.intent) {
      rejected.push({ ...proposal, reason: '缺少 intent（无法追溯）' });
      continue;
    }
    if (proposal.evidence.length === 0) {
      rejected.push({ ...proposal, reason: '缺少 evidence（无依据的动作不许执行）' });
      continue;
    }
    if (accepted.length >= MAX_ACCEPTED) {
      rejected.push({ ...proposal, reason: `超过单次上限 ${MAX_ACCEPTED} 条` });
      continue;
    }
    accepted.push(proposal);
  }
  return { accepted, rejected };
}

export interface EvidenceBundle {
  healthScore: number;
  healthWarnings: string[];
  quoteMismatches: number;
  orphans: number;
  brokenLinks: number;
  /** 召回为空的查询样本（帮她理解"记了但想不起来"）。 */
  recallMisses: Array<{ day: string; channel: string }>;
  lowImportanceChunks: number;
  duplicateChunks: number;
}

export async function collectEvidence(env: Env, now = Date.now()): Promise<EvidenceBundle> {
  const health = await loadHealth(env, 7).catch(() => null);
  const check = await runSelfCheck(env, now).catch(() => null);

  let recallMisses: EvidenceBundle['recallMisses'] = [];
  try {
    const res = await env.DB.prepare(
      `SELECT day_key, channel FROM recall_samples
       WHERE items = 0 ORDER BY id DESC LIMIT 10`,
    ).all<{ day_key: string; channel: string }>();
    recallMisses = (res.results ?? []).map((r) => ({ day: r.day_key, channel: r.channel }));
  } catch {
    recallMisses = [];
  }

  let lowImportanceChunks = 0;
  let duplicateChunks = 0;
  try {
    const low = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM memory_chunks WHERE importance <= 1',
    ).first<{ n: number | null }>();
    lowImportanceChunks = Number(low?.n) || 0;
    const dup = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM (
         SELECT content_hash FROM memory_chunks GROUP BY content_hash HAVING COUNT(*) > 1
       )`,
    ).first<{ n: number | null }>();
    duplicateChunks = Number(dup?.n) || 0;
  } catch {
    lowImportanceChunks = 0;
  }

  return {
    healthScore: health?.score ?? 0,
    healthWarnings: health?.warnings ?? [],
    quoteMismatches: check?.quoteMismatches.length ?? 0,
    orphans: check?.orphans.length ?? 0,
    brokenLinks: check?.brokenLinks ?? 0,
    recallMisses,
    lowImportanceChunks,
    duplicateChunks,
  };
}

const REVIEW_SYSTEM = [
  '你在审视自己的记忆系统，目标只有一个：让"该记得的被想起来、不该占位的别挡路"。',
  '严格输出 JSON 数组，不要 markdown，不要解释。每项：',
  '{"kind":"chunk.tune|param.tune|fact.expire","target":"对象id或参数名","intent":"一句话为什么","evidence":["指标或样本"],"value":"改成什么"}',
  '硬约束：',
  '1. 只能做这三类动作；改提示词、改规则、删记忆一律不许提；',
  '2. 每个动作必须有 evidence，写清是哪条指标/哪个样本支撑；',
  '3. 最多 5 个动作；没有把握就输出空数组 []；',
  '4. target 必须是**具体 id**（chunk_xxx / fact_xxx）或参数名；不知道 id 就不要提这个动作；',
  '5. 不要为了"做点什么"而改——不动也是一种正确。',
].join('\n');

export interface SelfReviewReport {
  date: string;
  ranAt: number;
  evidence: EvidenceBundle;
  proposals: number;
  accepted: Proposal[];
  rejected: Array<Proposal & { reason: string }>;
  applied: number;
  skipped: string;
}

function buildEvidenceText(evidence: EvidenceBundle): string {
  return [
    `健康分：${evidence.healthScore}` + (evidence.healthWarnings.length ? `（告警：${evidence.healthWarnings.join('；')}）` : ''),
    `自检：引文不一致 ${evidence.quoteMismatches}，孤儿 ${evidence.orphans}，断链 ${evidence.brokenLinks}`,
    `低重要度片段：${evidence.lowImportanceChunks}；重复片段组：${evidence.duplicateChunks}`,
    `召回为空的样本数：${evidence.recallMisses.length}`,
  ].join('\n');
}

/** 让模型提动作；解析失败一律视为"什么都不做"。 */
export async function proposeActions(
  env: Env,
  evidence: EvidenceBundle,
): Promise<Proposal[]> {
  const result = await distillText(
    env,
    REVIEW_SYSTEM,
    buildEvidenceText(evidence),
    700,
    env.SUMMARY_DEEPSEEK_MODEL || env.DEEPSEEK_MODEL,
  );
  await addLlmCost(env, dateKeyInBeijing(new Date()), result.cost).catch(() => {});
  const text = result.text.replace(/```json/gi, '').replace(/```/g, '').trim();
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(parsed)) return [];
    return parsed as Proposal[];
  } catch {
    return [];
  }
}

/** 执行（只做 A 档里最保守的那几件）。 */
export async function applyProposals(
  env: Env,
  proposals: Proposal[],
  now = Date.now(),
): Promise<{ applied: number; skipped: string }> {
  let applied = 0;
  const reasons: string[] = [];
  for (const proposal of proposals) {
    const kind = proposal.kind as ActionKind;
    try {
      assertAllowed(
        { kind, intent: proposal.intent, evidence: proposal.evidence },
        { actor: 'agent', channel: 'self-review' },
      );
    } catch (e) {
      reasons.push(`${proposal.kind}/${proposal.target}: ${(e as Error).message}`);
      continue;
    }

    // param.tune 目前没有可持久化的参数中心：只记审计，不改线上行为。
    if (kind === 'param.tune') {
      await recordAction(env, {
        actor: 'agent',
        kind,
        intent: proposal.intent,
        evidence: proposal.evidence,
        diff: `建议 ${proposal.target} = ${proposal.value}`,
        before: '未应用（参数中心未落地）',
        after: proposal.value,
        revertible: true,
      }, now).catch(() => {});
      reasons.push(`${proposal.target}: 参数建议已记录，未改变线上行为`);
      continue;
    }

    if (kind === 'chunk.tune') {
      const importance = Number(proposal.value);
      if (!Number.isFinite(importance) || importance < 1 || importance > 5) {
        reasons.push(`${proposal.target}: importance 只能是 1~5`);
        continue;
      }
      const res = await env.DB.prepare(
        'UPDATE memory_chunks SET importance = ?, updated_at = ? WHERE id = ?',
      )
        .bind(Math.round(importance), now, proposal.target)
        .run();
      const changed = Number(res?.meta?.changes ?? 0);
      if (changed > 0) {
        applied += 1;
        await recordAction(env, {
          actor: 'agent',
          kind,
          intent: proposal.intent,
          evidence: proposal.evidence,
          diff: `chunk ${proposal.target} importance = ${Math.round(importance)}`,
          before: '旧重要度',
          after: String(Math.round(importance)),
          revertible: true,
        }, now).catch(() => {});
      } else {
        reasons.push(`${proposal.target}: chunk 不存在`);
      }
      continue;
    }

    if (kind === 'fact.expire') {
      // 只允许把"已经很可疑"的事实再降一档，不允许直接失效。
      const res = await env.DB.prepare(
        `UPDATE memory_facts SET confidence = MAX(0.2, confidence - 0.1), updated_at = ?
         WHERE id = ? AND confidence < 0.6`,
      )
        .bind(now, proposal.target)
        .run();
      const changed = Number(res?.meta?.changes ?? 0);
      if (changed > 0) {
        applied += 1;
        await recordAction(env, {
          actor: 'agent',
          kind,
          intent: proposal.intent,
          evidence: proposal.evidence,
          diff: `fact ${proposal.target} 置信度再降 0.1`,
          before: '置信度 < 0.6',
          after: '再降 0.1',
          revertible: true,
        }, now).catch(() => {});
      } else {
        reasons.push(`${proposal.target}: 置信度不够低，不动`);
      }
    }
  }
  return { applied, skipped: reasons.join('; ') };
}

export async function runSelfReview(env: Env, now = Date.now()): Promise<SelfReviewReport> {
  const date = dateKeyInBeijing(new Date(now));
  const evidence = await collectEvidence(env, now);
  const proposals = await proposeActions(env, evidence);
  const { accepted, rejected } = vetProposals(proposals);
  const { applied, skipped } = await applyProposals(env, accepted, now);

  const report: SelfReviewReport = {
    date,
    ranAt: now,
    evidence,
    proposals: proposals.length,
    accepted,
    rejected,
    applied,
    skipped,
  };
  await putObject(env, `memory/self-review/${date}.json`, JSON.stringify(report, null, 2), {
    contentType: 'application/json',
  }).catch(() => {});
  return report;
}
