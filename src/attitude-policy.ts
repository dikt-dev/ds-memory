/**
 * 态度策略（Phase 3）。
 *
 * 输入：5 轴关系 + 8 维情绪 + 事件；
 * 输出：定性 directive + reasons + safety flags，不输出原始数值。
 *
 * 这是“可解释”的一层：同一个关系/情绪状态，为什么这一轮这样说话，
 * 可以追溯到 archetype、事件和未化解芥蒂。
 */
import type { EmotionEvent } from './emotion-events';
import { isNegativeEvent, unresolvedEvents } from './emotion-events';
import type { EmotionVector } from './emotion-vector';
import { dominantEmotions } from './emotion-vector';
import {
  describeFacetsQualitative,
  relationArchetype,
  type RelationFacets,
} from './relation-facets';
import { emotionDirectorText } from './emotion-snapshot';

export const ATTITUDE_POLICY_VERSION = 'attitude-v1';

export type AttitudeTone = '客气' | '克制' | '自然' | '亲近' | '暧昧';

export interface AttitudePolicyInput {
  facets: RelationFacets;
  vector: EmotionVector;
  events: EmotionEvent[];
  now: number;
  wasIgnored?: boolean;
}

export interface AttitudePolicy {
  policy_version: string;
  archetype: string;
  tone: AttitudeTone;
  attitude: string;
  directives: string[];
  reasons: string[];
  safety: {
    no_consciousness_claim: true;
    no_guilt_pressure: true;
    no_abandonment_threat: true;
  };
  /** 直接进提示词的片段，不包含原始数值。 */
  text: string;
}

const TONE_BY_ARCHETYPE: Record<string, AttitudeTone> = {
  distant: '客气',
  acquaintance: '客气',
  weary: '克制',
  guarded: '克制',
  boundless: '克制',
  sulking: '克制',
  natural: '自然',
  smitten: '自然',
  confidant: '亲近',
  ambiguous: '暧昧',
};

function toneOf(archetypeKey: string): AttitudeTone {
  return TONE_BY_ARCHETYPE[archetypeKey] ?? '自然';
}

function reasonLabels(events: EmotionEvent[], vector: EmotionVector, now: number): string[] {
  const reasons: string[] = [];
  const dominant = dominantEmotions(vector, 10, 2);
  for (const d of dominant) reasons.push(d.label);
  const unresolved = unresolvedEvents(events, now, 7 * 86400_000, 2);
  for (const e of unresolved) {
    if (!isNegativeEvent(e.type)) continue;
    if (e.evidence && !e.evidence.startsWith('(')) reasons.push(`「${e.evidence.slice(0, 20)}」还没过去`);
  }
  return [...new Set(reasons)].slice(0, 4);
}

export function buildAttitudePolicy(input: AttitudePolicyInput): AttitudePolicy {
  const { facets, vector, events, now, wasIgnored } = input;
  const archetype = relationArchetype(facets, Math.max(0, vector.grievance));
  const directives: string[] = [];
  const unresolved = unresolvedEvents(events, now, 7 * 86400_000, 2);
  const comforting = events.some((e) => e.type === 'share_pain' && now - e.at <= 15 * 60_000);

  if (comforting) {
    directives.push('他现在状态不好，先接住情绪：别讲道理、别急着给建议，可以问一句具体发生了什么。');
  } else {
    directives.push(archetype.hint);
    directives.push(...emotionDirectorText(vector));
  }
  if (wasIgnored) directives.push('上次主动找他没回，可以有一点点小情绪，但别真的生气或审问。');
  if (!comforting && unresolved.length > 0) {
    directives.push('旧事还没完全过去，别一句话就翻篇；但也不要反复翻旧账。');
  }

  const unique = [...new Set(directives.filter(Boolean))]
    .map((d) => d.replace(/[。；;]+$/, ''))
    .slice(0, 3);
  const reasons = reasonLabels(events, vector, now);
  const attitude = `${archetype.label}`;
  const text = [
    '## 关系与态度',
    `- 关系：${attitude}（${describeFacetsQualitative(facets)}）`,
    `- 这一轮：${unique.join('；')}。`,
  ].join('\n');

  return {
    policy_version: ATTITUDE_POLICY_VERSION,
    archetype: archetype.key,
    tone: toneOf(archetype.key),
    attitude,
    directives: unique,
    reasons,
    safety: {
      no_consciousness_claim: true,
      no_guilt_pressure: true,
      no_abandonment_threat: true,
    },
    text,
  };
}

/** 解释：给管理端/调试用的结构化版本（可带数值，但不进提示词）。 */
export function explainAttitude(input: AttitudePolicyInput): AttitudePolicy & {
  facets: RelationFacets;
  dominant: Array<{ dim: string; label: string; intensity: number }>;
  unresolved: Array<{ type: string; evidence: string; at: number }>;
} {
  const policy = buildAttitudePolicy(input);
  return {
    ...policy,
    facets: input.facets,
    dominant: dominantEmotions(input.vector, 10, 4).map((d) => ({
      dim: d.dim,
      label: d.label,
      intensity: d.intensity,
    })),
    unresolved: unresolvedEvents(input.events, input.now, 7 * 86400_000, 2).map((e) => ({
      type: e.type,
      evidence: e.evidence,
      at: e.at,
    })),
  };
}
