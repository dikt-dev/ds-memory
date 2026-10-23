/**
 * 关系与心情系统（纯函数）。
 *
 * 三个数值共同决定 AI 对用户的态度：
 * - 好感度 affinity（0-1000）：长期积累的喜欢程度，变化慢
 * - 亲密度 intimacy（0-1000）：熟悉与信任程度，变化慢
 * - 心情值 mood（0-1000）：短期情绪状态，变化快（小时级）
 *
 * 设计原则：
 * 好感度 × 亲密度 决定「基调」（长期关系定位）
 * 心情值 决定「当下表现」（同样关系下，心情好就更热情，心情差就更冷淡）
 */

export interface Stage {
  min: number;
  label: string;
}

export const RELATION_MAX_SCORE = 1000;

/** 好感度阶段 */
export const AFFINITY_STAGES: Stage[] = [
  { min: 0, label: '疏离' },
  { min: 200, label: '客气' },
  { min: 400, label: '熟悉' },
  { min: 600, label: '亲近' },
  { min: 800, label: '亲密' },
];

/** 亲密度阶段 */
export const INTIMACY_STAGES: Stage[] = [
  { min: 0, label: '陌生' },
  { min: 150, label: '认识' },
  { min: 350, label: '熟络' },
  { min: 600, label: '交心' },
  { min: 850, label: '知己' },
];

/** 心情阶段 */
export const MOOD_STAGES: Stage[] = [
  { min: 0, label: '低落' },
  { min: 350, label: '平静' },
  { min: 550, label: '轻快' },
  { min: 750, label: '愉快' },
  { min: 900, label: '雀跃' },
];

/** 阶段索引。 */
export function stageIndex(value: number, stages: Stage[]): number {
  let idx = 0;
  for (let i = 0; i < stages.length; i++) {
    if (value >= stages[i].min) idx = i;
  }
  return idx;
}

/** 基调矩阵：行 = 好感度阶段（疏离→亲密），列 = 亲密度阶段（陌生→知己）。 */
const ATTITUDE_MATRIX: string[][] = [
  ['冷淡疏离', '客气而疏远', '礼貌但保持距离', '藏着心事', '别扭的亲近'],
  ['礼貌客气', '有分寸的友好', '客气熟络', '温和亲近', '克制的情谊'],
  ['热情客气', '友好自然', '轻松熟络', '亲近信任', '亲密默契'],
  ['热络而试探', '热情亲近', '亲近自然', '交心之谊', '亲密无间'],
  ['热烈亲近', '亲密熟络', '亲密交心', '深深信任', '灵魂默契'],
];

/**
 * 每个基调对应的"热度"（用于心情位移）。
 */
const TONE_HEAT: Record<string, number> = {
  冷淡疏离: 0, 客气而疏远: 0, 礼貌但保持距离: 1, 藏着心事: 1, 别扭的亲近: 2,
  礼貌客气: 1, 有分寸的友好: 2, 客气熟络: 2, 温和亲近: 3, 克制的情谊: 3,
  热情客气: 2, 友好自然: 3, 轻松熟络: 3, 亲近信任: 4, 亲密默契: 4,
  热络而试探: 3, 热情亲近: 4, 亲近自然: 4, 交心之谊: 4, 亲密无间: 5,
  热烈亲近: 4, 亲密熟络: 5, 亲密交心: 5, 深深信任: 5, 灵魂默契: 5,
};

export interface RelationStatus {
  affinity: number;
  intimacy: number;
  mood: number;
  affinity_stage: string;
  intimacy_stage: string;
  mood_stage: string;
  /** 基调（不含心情）：长期关系定位 */
  base_attitude: string;
  /** 最终态度（含心情修饰） */
  attitude: string;
  /** 心情对基调的影响方向 */
  mood_effect: 'warmer' | 'cooler' | 'neutral';
}

function clampScore(n: number): number {
  return Math.min(Math.max(Math.round(n), 0), RELATION_MAX_SCORE);
}

/** 心情阶段标签（合并相邻重复档）。 */
function moodLabel(mood: number): string {
  if (mood < 350) return '低落';
  if (mood < 550) return '平静';
  if (mood < 750) return '轻快';
  if (mood < 900) return '愉快';
  return '雀跃';
}

/** 由三个数值得到阶段 + 综合态度。 */
export function buildRelationStatus(affinity: number, intimacy: number, mood = 500): RelationStatus {
  const a = clampScore(affinity);
  const i = clampScore(intimacy);
  const m = clampScore(mood);
  const ai = stageIndex(a, AFFINITY_STAGES);
  const ii = stageIndex(i, INTIMACY_STAGES);
  const baseAttitude = ATTITUDE_MATRIX[ai][ii];

  // 心情修饰：直接在矩阵中移动列（亲密度维度），更符合语义
  const moodKey = moodLabel(m);
  let shift = 0;
  if (moodKey === '低落') shift = -2;
  else if (moodKey === '平静') shift = 0;
  else if (moodKey === '轻快') shift = +1;
  else if (moodKey === '愉快') shift = +1;
  else if (moodKey === '雀跃') shift = +2;

  // 高热度基调时，向上位移空间有限，自动收敛
  const baseHeat = TONE_HEAT[baseAttitude] ?? 2;
  if (shift > 0) shift = Math.min(shift, Math.max(0, 5 - baseHeat));
  if (shift < 0) shift = Math.max(shift, -Math.min(2, baseHeat));

  const targetCol = Math.min(4, Math.max(0, ii + shift));
  const finalAttitude = shift === 0 ? baseAttitude : ATTITUDE_MATRIX[ai][targetCol];

  return {
    affinity: a,
    intimacy: i,
    mood: m,
    affinity_stage: AFFINITY_STAGES[ai].label,
    intimacy_stage: INTIMACY_STAGES[ii].label,
    mood_stage: moodKey,
    base_attitude: baseAttitude,
    attitude: finalAttitude,
    mood_effect: shift > 0 ? 'warmer' : shift < 0 ? 'cooler' : 'neutral',
  };
}

/** 供系统提示词使用的一句话态度描述。 */
export function describeAttitude(affinity: number, intimacy: number, mood = 500): string {
  const s = buildRelationStatus(affinity, intimacy, mood);
  const effectText =
    s.mood_effect === 'warmer' ? '（心情好，比平时更热情）'
    : s.mood_effect === 'cooler' ? '（心情差，比平时冷淡些）'
    : '';
  return `${s.attitude}${effectText}（好感度 ${s.affinity}/1000 · 亲密度 ${s.intimacy}/1000 · 心情 ${s.mood}/1000）`;
}

/** 心情值的自然回归：向基线缓慢靠拢（避免长期停留在极端）。 */
export function driftMood(current: number, baseline = 500, rate = 0.05): number {
  return clampScore(current + (baseline - current) * rate);
}

/** 心情的单日变化上限（比好感度/亲密度快，但仍有边界）。 */
export const MOOD_MAX_DAILY_DELTA = 80;

/** 心情变化截断。 */
export function applyMoodDelta(current: number, proposed: number, maxDelta = MOOD_MAX_DAILY_DELTA): number {
  const delta = Math.min(Math.max(proposed - current, -maxDelta), maxDelta);
  return clampScore(current + delta);
}
