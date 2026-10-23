/**
 * 情绪向量（纯函数）。
 *
 * 为什么不再用「一个心情值」：
 * 0-1000 的单一 mood 只能表达「好/不好」，落不到具体情绪上，模型只好写成同一种甜。
 * 这里把情绪拆成 8 个维度，每维独立变化、独立衰减，才能表达
 * 「心里有点委屈，但又忍不住有点开心」这种真实矛盾。
 *
 * 各维取值范围统一为 -100 ~ +100（0 = 中性）：
 * - valence    愉悦度：负=难受，正=舒服
 * - arousal    激活度：负=蔫，正=兴奋
 * - dominance  掌控感：负=没底气/被压着，正=有底气
 * - attachment 依恋：负=疏离/被冷落，正=黏人
 * - jealousy   醋意：只在提到别人时上升
 * - grievance  委屈/芥蒂：★ 不按时间自然衰减，只能被「道歉/哄」修掉
 * - shyness    害羞：被夸、被表白时上升，衰减极快
 * - fatigue    疲惫：轮次 + 时段累积
 *
 * 衰减用半衰期：每个维度衰减速度不同（害羞 15 分钟就散，依恋能撑 6 小时）。
 * grievance 是唯一不随时间衰减的维度——这是「闹别扭 → 哄 → 和好」这条关系弧线的前提。
 * 若所有情绪都 12 分钟散光，就永远不会有真正的张力。
 */

import { computeMoodDrift, type MoodEnvironment } from './mood-env';

export type EmotionDim =
  | 'valence'
  | 'arousal'
  | 'dominance'
  | 'attachment'
  | 'jealousy'
  | 'grievance'
  | 'shyness'
  | 'fatigue';

export const EMOTION_DIMS: EmotionDim[] = [
  'valence',
  'arousal',
  'dominance',
  'attachment',
  'jealousy',
  'grievance',
  'shyness',
  'fatigue',
];

export type EmotionVector = Record<EmotionDim, number>;

/** 情绪向量分量上限（绝对值）。 */
export const EMOTION_MAX = 100;

/** 单轮单维最大变化量（防止一句话把情绪打满）。 */
export const EMOTION_MAX_STEP_PER_TURN = 30;

/**
 * 各维度半衰期（分钟）。null = 不按时间衰减（由每日任务单独处理）。
 *
 * 取值依据：
 * - shyness 15min：害羞本来就散得快
 * - arousal 25min：兴奋劲儿来得快去得也快
 * - valence 40min：整体好坏感受比单点情绪持久
 * - dominance 2h：被压一头的憋屈能撑一阵
 * - jealousy 3h：醋意比一般情绪黏
 * - fatigue 4h：累了要睡一觉才好
 * - attachment 6h：被冷落的失落能挂半天
 * - grievance 不衰减：芥蒂要人哄才消
 */
export const EMOTION_HALF_LIFE_MIN: Record<EmotionDim, number | null> = {
  valence: 40,
  arousal: 25,
  dominance: 120,
  attachment: 360,
  jealousy: 180,
  grievance: null,
  shyness: 15,
  fatigue: 240,
};

/** 空向量（全中性）。 */
export function emptyEmotionVector(): EmotionVector {
  return {
    valence: 0,
    arousal: 0,
    dominance: 0,
    attachment: 0,
    jealousy: 0,
    grievance: 0,
    shyness: 0,
    fatigue: 0,
  };
}

/** 这些维度只有正向有意义（负值一律当 0）：委屈不会「负着委屈」。 */
export const UNIPOLAR_DIMS: EmotionDim[] = ['jealousy', 'grievance', 'shyness', 'fatigue'];

function clampEmotion(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(Math.max(Math.round(n), -EMOTION_MAX), EMOTION_MAX);
}

/** 按维度语义夹紧（单向维度不允许负值）。 */
function clampByDim(dim: EmotionDim, n: number): number {
  const v = clampEmotion(n);
  return UNIPOLAR_DIMS.includes(dim) ? Math.max(0, v) : v;
}

/** 时间衰减：按各维半衰期指数回落。grievance 原样保留。 */
export function decayEmotion(vector: EmotionVector, elapsedMinutes: number): EmotionVector {
  const mins = Math.max(0, elapsedMinutes);
  if (mins <= 0) return { ...vector };
  const next = emptyEmotionVector();
  for (const dim of EMOTION_DIMS) {
    const halfLife = EMOTION_HALF_LIFE_MIN[dim];
    if (halfLife === null) {
      next[dim] = clampEmotion(vector[dim]);
      continue;
    }
    // 衰减到 1 以下就归零，避免永远挂着 0.4 这种噪声
    const factor = Math.pow(0.5, mins / halfLife);
    const v = vector[dim] * factor;
    next[dim] = Math.abs(v) < 1 ? 0 : clampByDim(dim, v);
  }
  return next;
}

/** 叠加情绪变化：单维单轮不超过 ±EMOTION_MAX_STEP_PER_TURN。 */
export function applyEmotionDelta(
  current: EmotionVector,
  delta: Partial<EmotionVector>,
  maxStep = EMOTION_MAX_STEP_PER_TURN,
): EmotionVector {
  const next = emptyEmotionVector();
  for (const dim of EMOTION_DIMS) {
    const d = delta[dim] ?? 0;
    const capped = Math.min(Math.max(d, -maxStep), maxStep);
    next[dim] = clampByDim(dim, current[dim] + capped);
  }
  return next;
}

/** 芥蒂的每日衰减：默认只退 20%（且低于 8 直接归零）。道歉另有一次性大幅抵扣。 */
export function decayGrievanceDaily(vector: EmotionVector, rate = 0.2): EmotionVector {
  const next = { ...vector };
  const v = next.grievance * (1 - Math.min(Math.max(rate, 0), 1));
  next.grievance = Math.abs(v) < 8 ? 0 : clampEmotion(v);
  return next;
}

/** 各维度的正/负向中文标签。 */
export const EMOTION_LABELS: Record<EmotionDim, { positive: string; negative: string }> = {
  valence: { positive: '轻快', negative: '低落' },
  arousal: { positive: '兴奋', negative: '提不起劲' },
  dominance: { positive: '有底气', negative: '没底气' },
  attachment: { positive: '黏人', negative: '有点疏离' },
  jealousy: { positive: '吃醋', negative: '吃醋' },
  grievance: { positive: '委屈', negative: '委屈' },
  shyness: { positive: '害羞', negative: '害羞' },
  fatigue: { positive: '疲惫', negative: '疲惫' },
};

export interface DominantEmotion {
  dim: EmotionDim;
  /** 绝对值 0-100 */
  intensity: number;
  /** 该维度当前取值（带正负） */
  value: number;
  /** 中文标签，如「委屈」「轻快」 */
  label: string;
  /** 可直接进提示词的短语，如「委屈 35」 */
  phrase: string;
}

/** 只认这几个维度是「情绪本身就带方向」的，正负都叫同一个名字。 */
const UNIPOLAR_LABEL_DIMS: EmotionDim[] = UNIPOLAR_DIMS;

/**
 * 取当前最显著的若干情绪（按绝对值排序）。
 *
 * @param min 强度阈值，低于它视为无感（默认 15）
 * @param limit 最多返回几条（默认 2，提示词里超过两条就啰嗦了）
 */
export function dominantEmotions(vector: EmotionVector, min = 15, limit = 2): DominantEmotion[] {
  const items: DominantEmotion[] = [];
  for (const dim of EMOTION_DIMS) {
    const value = clampEmotion(vector[dim]);
    const intensity = Math.abs(value);
    if (intensity < min) continue;
    const uni = UNIPOLAR_LABEL_DIMS.includes(dim);
    // 单向维度（委屈/吃醋/害羞/疲惫）只有正向有意义，负值视为无感
    if (uni && value <= 0) continue;
    const label = uni
      ? EMOTION_LABELS[dim].positive
      : value >= 0
        ? EMOTION_LABELS[dim].positive
        : EMOTION_LABELS[dim].negative;
    items.push({ dim, intensity, value, label, phrase: `${label} ${intensity}` });
  }
  items.sort((a, b) => b.intensity - a.intensity);
  return items.slice(0, limit);
}

/** 情绪向量的可读签名（日志/测试用）。 */
export function emotionSignature(vector: EmotionVector): string {
  const parts = EMOTION_DIMS.filter((d) => vector[d] !== 0).map((d) => `${d}:${vector[d]}`);
  return parts.length === 0 ? 'neutral' : parts.join(',');
}

/**
 * 由情绪向量派生的心情值（0-1000，兼容旧记忆里的「心情值」行）。
 *
 * ★ 为什么要派生：之前心情值是一条独立链路（AI 提议 + 环境漂移 + 会话残留），
 *   和 8 维情绪向量各算各的，偶尔会打架（一个说低落、一个说轻快）。
 *   现在向量是唯一真相源，心情值只是它的一个“投影”，给状态卡的 5 档心情用。
 *
 * 权重依据：愉悦度是主项；委屈/疲惫拉低，依恋/激活略微抬高。系数保守，
 * 单维打满（±100）也只会把心情推到 180~830，不会直接顶死两端。
 */
export function moodFromVector(vector: EmotionVector): number {
  const raw =
    500 +
    vector.valence * 3.2 +
    vector.arousal * 0.8 +
    vector.attachment * 0.5 -
    vector.grievance * 1.2 -
    vector.fatigue * 0.9 +
    vector.shyness * 0.3;
  return Math.min(1000, Math.max(0, Math.round(raw)));
}

/** 安全解析（KV 里读出来的历史数据可能缺字段 / 是脏的）。 */
export function parseEmotionVector(raw: unknown): EmotionVector {
  const base = emptyEmotionVector();
  if (!raw || typeof raw !== 'object') return base;
  const obj = raw as Record<string, unknown>;
  for (const dim of EMOTION_DIMS) {
    const n = Number(obj[dim]);
    base[dim] = Number.isFinite(n) ? clampEmotion(n) : 0;
  }
  return base;
}

/**
 * 环境对「它自己情绪」的独立影响（用户要求：情绪要有来源）。
 *
 * 与 mood-env 的区别：
 * - mood-env 算的是「心情值」的漂移（0-1000 那条线）
 * - 这里算的是情绪向量里 valence / arousal / fatigue 的自发变化
 *
 * 也就是说：今天下大雨、凌晨三点，它会自己先有点蔫，
 * 而不是完全等用户说什么才产生情绪。
 */
export function applyEnvironmentToEmotion(
  vector: EmotionVector,
  environment: MoodEnvironment,
): EmotionVector {
  const drift = computeMoodDrift(environment);
  // mood 漂移量级（-25~+12）压到情绪向量尺度（约 1/3），避免环境盖过对话本身
  const valence = Math.round(drift.delta / 3);
  const arousal = drift.delta > 0 ? Math.min(6, Math.round(drift.delta / 2)) : -4;

  // 疲惫：深夜、清晨、休息日被打扰
  let fatigue = 0;
  const h = environment.hour;
  if (h >= 0 && h < 5) fatigue = 12;
  else if (h >= 23) fatigue = 8;
  else if (h >= 5 && h < 8) fatigue = 5;

  return applyEmotionDelta(vector, { valence, arousal, fatigue });
}
