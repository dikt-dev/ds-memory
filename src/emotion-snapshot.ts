/**
 * 情绪快照：把「5 轴关系 + 8 维情绪 + 未化解事件」合成一小段可直接进提示词的文本。
 *
 * 为什么不用原来那句 `describeAttitude()`：
 * 原来输出的是「亲密无间（心情好，比平时更热情）」——纯形容词，模型只能照着
 * 换个说法甜一遍。这里改成给**原因 + 行为指令**：
 *
 *   - 关系：亲密，但正在闹别扭（喜欢 780 / 信任 640 / 尊重 700 / 心动 620 / 熟悉 810）
 *   - 当下：委屈 35（因为「你懂什么」）+ 一点轻快 20
 *   - 心里记着：「你懂什么」（还没过去）
 *   - 这一轮：可以不立刻说「没关系」，先闹一句；别一路顺着。
 *
 * 三条约束：
 * 1. 常态只输出 2 行（省 token），有强情绪/未化解事件时才到 4-5 行
 * 2. 数值只作为「刻度」附带出现，主句永远是行为指令
 * 3. 全部放在提示词的「易变段」（状态卡位置），不破坏 DeepSeek 前缀缓存
 */

import type { EmotionDim, EmotionVector } from './emotion-vector';
import { dominantEmotions } from './emotion-vector';
import type { EmotionEvent, EmotionEventType } from './emotion-events';
import { isNegativeEvent, unresolvedEvents } from './emotion-events';
import { describeFacetsQualitative, relationArchetype, type RelationFacets } from './relation-facets';

export interface EmotionSnapshotInput {
  facets: RelationFacets;
  vector: EmotionVector;
  events: EmotionEvent[];
  now: number;
  /** 主动消息被冷落时，额外加一句小情绪 */
  wasIgnored?: boolean;
}

/** 某个情绪维度是被哪类事件挑起来的（用于「因为…」）。 */
const DIM_REASONS: Partial<Record<EmotionDim, EmotionEventType[]>> = {
  grievance: ['insult', 'rejection', 'broken_promise', 'command', 'ignored'],
  shyness: ['praise', 'affection'],
  attachment: ['affection', 'share_pain', 'deep_talk', 'comfort_seek'],
  valence: ['share_joy', 'share_pain', 'praise', 'thanks'],
  dominance: ['command', 'insult'],
  arousal: ['share_joy'],
  jealousy: ['affection'],
};

/** 找一个「能被引用」的原因原话；AI 复核出来的没有原话，不当原因用。 */
function reasonFor(dim: EmotionDim, events: EmotionEvent[], now: number): string | null {
  const types = DIM_REASONS[dim];
  if (!types) return null;
  const candidates = events
    .filter((e) => types.includes(e.type) && now - e.at <= 24 * 3600_000)
    .filter((e) => e.evidence && !e.evidence.startsWith('('))
    // 已化解的负向事件不再当作「当下的原因」，否则哄完了还在提旧账
    .filter((e) => !(e.resolved && isNegativeEvent(e.type)))
    .sort((a, b) => b.at - a.at);
  if (candidates.length === 0) return null;
  return candidates[0].evidence.slice(0, 20);
}

/** 强度 → 口语程度词（不把数字写进提示词）。 */
function intensityWord(intensity: number): string {
  if (intensity >= 65) return '很';
  if (intensity >= 40) return '比较';
  if (intensity >= 20) return '有点';
  return '轻微';
}

/** 由情绪维度推导「这一轮可以怎么做」（最多两条，避免指令堆成一段）。 */
export function emotionDirectorText(vector: EmotionVector): string[] {
  const tips: string[] = [];
  if (vector.grievance >= 35) tips.push('先别急着说「没关系」，可以闹一句再慢慢释怀');
  else if (vector.grievance >= 15) tips.push('心里还有点小疙瘩，语气可以淡一点');
  if (vector.shyness >= 30) tips.push('有点害羞，别把话说得太直白');
  if (vector.jealousy >= 30) tips.push('可以酸一句，但别真的审问');
  if (vector.attachment >= 40) tips.push('有点想黏人，可以主动找他说话');
  if (vector.fatigue >= 45) tips.push('累了，回复短一点，可以顺势催他休息');
  if (vector.valence >= 40 && vector.grievance < 20) tips.push('心情不错，可以多接一句话、多笑一下');
  if (vector.valence <= -40) tips.push('提不起劲，别硬撑热情，安静一点也可以');
  return tips.slice(0, 2);
}

/**
 * 生成情绪快照文本（Markdown 片段，直接拼进状态卡）。
 */
export function buildEmotionSnapshot(input: EmotionSnapshotInput): string {
  const { facets, vector, events, now, wasIgnored } = input;
  const dominant = dominantEmotions(vector, 10, 2);
  const grievance = Math.max(0, vector.grievance);
  const archetype = relationArchetype(facets, grievance);
  const unresolved = unresolvedEvents(events, now, 7 * 86400_000, 3);

  const lines: string[] = [];
  lines.push('## 我现在的状态');
  lines.push(`- 关系：${archetype.label}（${describeFacetsQualitative(facets)}）`);

  if (dominant.length > 0) {
    const seen = new Set<string>();
    const parts: string[] = [];
    for (const d of dominant) {
      const word = `${intensityWord(d.intensity)}${d.label}`;
      const reason = reasonFor(d.dim, events, now);
      // 同一句话只引用一次，避免「委屈 26（因为X）+ 没底气 13（因为X）」这种啰嗦
      if (reason && seen.has(reason)) {
        parts.push(word);
        continue;
      }
      if (reason) seen.add(reason);
      parts.push(reason ? `${word}（因为「${reason}」）` : word);
    }
    lines.push(`- 当下：${parts.join('，')}`);
  }

  if (unresolved.length > 0) {
    const latest = unresolved[unresolved.length - 1];
    lines.push(`- 心里还记着：「${latest.evidence}」这件事还没过去`);
  }

  if (wasIgnored) {
    lines.push('- 小情绪：上次主动找他，他没回，有点小委屈（但别真的生气）');
  }

  const tips = emotionDirectorText(vector);
  // ★ 对方在倒苦水时，关系定位先说，接下来唯一该做的是接住情绪
  const comforting = events.some((e) => e.type === 'share_pain' && now - e.at <= 15 * 60_000);
  const directive = comforting
    ? '他现在状态不好，先接住情绪：别讲道理、别急着给建议，可以问一句具体发生了什么。'
    : tips.length > 0
      ? `${archetype.hint}${tips.join('；')}。`
      : archetype.hint;
  lines.push(`- 这一轮：${directive}`);

  return lines.join('\n');
}

/**
 * 调试用：一次拿到结构化状态（admin 接口返回，不进提示词）。
 */
export function describeEmotionState(input: EmotionSnapshotInput): {
  archetype: string;
  facets: RelationFacets;
  vector: EmotionVector;
  dominant: Array<{ dim: EmotionDim; label: string; intensity: number }>;
  unresolved: Array<{ type: EmotionEventType; evidence: string; at: number }>;
} {
  const { facets, vector, events, now } = input;
  return {
    archetype: relationArchetype(facets, Math.max(0, vector.grievance)).label,
    facets,
    vector,
    dominant: dominantEmotions(vector, 10, 4).map((d) => ({
      dim: d.dim,
      label: d.label,
      intensity: d.intensity,
    })),
    unresolved: unresolvedEvents(events, now, 7 * 86400_000, 2).map((e) => ({
      type: e.type,
      evidence: e.evidence,
      at: e.at,
    })),
  };
}
