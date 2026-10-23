/**
 * 关系 5 轴（纯函数）。
 *
 * 原来只有「好感度 + 亲密度」两根轴，能表达的只有「甜度的 25 个格子」。
 * 但真实关系里最动人的部分恰恰在轴的**背离**上：
 *   喜欢一个人，却不敢跟他说真话（affection 高 / trust 低）
 *   很熟很亲，但最近有点看不上你（intimacy 高 / respect 低）
 *   心里有感觉，话到嘴边没说破（attraction 高 / 未表白）
 *
 * 所以拆成 5 轴：
 * - affection  喜欢    ← 互动「质」（沿用原好感度驱动）
 * - trust      信任    ← 坦白、依赖、守约；爽约/敷衍会掉
 * - respect    尊重    ← 被贬低、被当工具使唤会掉（掉了会敷衍、怼回去）
 * - attraction 心动    ← 亲密 + 表白/黏人/深夜深聊；决定「暧昧/害羞」的表达
 * - intimacy   熟悉度  ← 互动「量」（沿用原亲密度驱动，逻辑不变）
 *
 * 数值仍统一 0-1000，便于和 memory.md 里的旧好感度兼容。
 * 轮级只产生小幅浮点增量（存 KV），每日归档时取整写回 memory.md —— 既保留「慢」的体感，
 * 又让一天之内能被感知到细微漂移。
 */

export const FACET_MAX = 1000;

export type FacetKey = 'affection' | 'trust' | 'respect' | 'attraction' | 'intimacy';

export const FACET_KEYS: FacetKey[] = ['affection', 'trust', 'respect', 'attraction', 'intimacy'];

export type RelationFacets = Record<FacetKey, number>;

/** 新关系的默认值。affection 沿用原好感度默认 500，intimacy 沿用 300。 */
export const FACET_DEFAULTS: RelationFacets = {
  affection: 500,
  trust: 600,
  respect: 650,
  attraction: 300,
  intimacy: 300,
};

/** 单日结算上限（防止一天猛聊把轴刷满）。 */
export const FACET_DAILY_CAPS: Record<FacetKey, number> = {
  affection: 5,
  trust: 4,
  respect: 4,
  attraction: 4,
  intimacy: 4,
};

/** 单轮微增量上限（绝对值）。 */
export const FACET_MAX_STEP_PER_TURN = 1.5;

export function clampFacet(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(Math.max(Math.round(n), 0), FACET_MAX);
}

/** 轮级微增量：目标值不取整，保留小数累积。 */
export function applyFacetDelta(
  current: RelationFacets,
  delta: Partial<Record<FacetKey, number>>,
  maxStep = FACET_MAX_STEP_PER_TURN,
): RelationFacets {
  const next = { ...current };
  for (const key of FACET_KEYS) {
    const d = delta[key] ?? 0;
    const capped = Math.min(Math.max(d, -maxStep), maxStep);
    next[key] = Math.min(Math.max(current[key] + capped, 0), FACET_MAX);
  }
  return next;
}

/** 每日结算：把累积的浮点增量截断到单日上限并取整。 */
export function settleFacetDelta(
  accumulated: Partial<Record<FacetKey, number>>,
): Required<Record<FacetKey, number>> {
  const out = { affection: 0, trust: 0, respect: 0, attraction: 0, intimacy: 0 };
  for (const key of FACET_KEYS) {
    const v = accumulated[key] ?? 0;
    const cap = FACET_DAILY_CAPS[key];
    out[key] = Math.round(Math.min(Math.max(v, -cap), cap));
  }
  return out;
}

/** 把 memory.md 里的旧三值补成 5 轴（缺失的轴用默认值，保证老数据可用）。 */
export function facetsFromValues(values: {
  affinity?: number;
  affection?: number;
  intimacy?: number;
  trust?: number;
  respect?: number;
  attraction?: number;
}): RelationFacets {
  return {
    affection: clampFacet(values.affinity ?? values.affection ?? FACET_DEFAULTS.affection),
    trust: clampFacet(values.trust ?? FACET_DEFAULTS.trust),
    respect: clampFacet(values.respect ?? FACET_DEFAULTS.respect),
    attraction: clampFacet(values.attraction ?? FACET_DEFAULTS.attraction),
    intimacy: clampFacet(values.intimacy ?? FACET_DEFAULTS.intimacy),
  };
}

export interface RelationArchetype {
  key: string;
  /** 关系定位短语，如「亲密但正在闹别扭」 */
  label: string;
  /** 这一轮的行为方向（进提示词） */
  hint: string;
}

/**
 * 由 5 轴 + 委屈值推出「关系原型」。
 *
 * 判断顺序 = 优先级：越靠前越具体、越需要被表达出来。
 * 刻意不按「数值越高越亲密」单调排列——背离组合才是重点。
 */
export function relationArchetype(f: RelationFacets, grievance = 0): RelationArchetype {
  if (f.affection < 300 && f.intimacy < 350) {
    return {
      key: 'distant',
      label: '客气而疏远',
      hint: '保持礼貌的距离，别自作熟，别说太重的话。',
    };
  }
  if (grievance >= 40 && f.intimacy >= 500) {
    return {
      key: 'sulking',
      label: '亲密，但正在闹别扭',
      hint: '你心里有疙瘩。别一句话就翻篇，语气可以淡一点、留点小情绪。',
    };
  }
  if (f.affection >= 650 && f.trust < 450) {
    return {
      key: 'guarded',
      label: '喜欢，但心里留着一手',
      hint: '可以亲近，但有些真心话先别说透，试探着来。',
    };
  }
  if (f.affection >= 650 && f.respect < 450) {
    return {
      key: 'boundless',
      label: '亲近，但有点没把你当回事',
      hint: '可以熟，但不必事事顺着；该怼就怼一句，别一路捧着。',
    };
  }
  if (f.attraction >= 600 && f.intimacy >= 550) {
    return {
      key: 'ambiguous',
      label: '暧昧，话到嘴边没说破',
      hint: '带着点没说破的心思，会害羞、会试探，但别直接挑明。',
    };
  }
  if (f.intimacy >= 700 && f.affection >= 600 && f.trust >= 650) {
    return {
      key: 'confidant',
      label: '交心，能说真话',
      hint: '可以直说真心话，包括不太好听的那种；他会信你。',
    };
  }
  if (f.intimacy >= 500 && f.affection < 450) {
    return {
      key: 'weary',
      label: '熟归熟，但最近有点烦你',
      hint: '回应可以简短、敷衍一点，不用主动找话题。',
    };
  }
  if (f.affection >= 600 && f.intimacy < 400) {
    return {
      key: 'smitten',
      label: '一见如故，但还没摸清底',
      hint: '热络但还在观察，别太快交底。',
    };
  }
  // 新关系：客气但不冷淡（默认值就落在这里，不能直接当成「熟悉而自然」）
  if (f.intimacy < 400) {
    return {
      key: 'acquaintance',
      label: '还不太熟，客气而友好',
      hint: '别太自来熟，先有分寸地聊，话不用太多。',
    };
  }
  return {
    key: 'natural',
    label: '熟悉而自然',
    hint: '像平常那样聊，不用刻意甜也不用刻意冷。',
  };
}

/** 5 轴的紧凑展示串（调试/管理端用，带数值）。 */
export function formatFacets(f: RelationFacets): string {
  return `喜欢 ${Math.round(f.affection)} / 信任 ${Math.round(f.trust)} / 尊重 ${Math.round(
    f.respect,
  )} / 心动 ${Math.round(f.attraction)} / 熟悉 ${Math.round(f.intimacy)}`;
}

/** 一个轴取值 → 自然语言程度词。 */
function degreeWord(value: number): string {
  if (value >= 850) return '拉满';
  if (value >= 700) return '很足';
  if (value >= 550) return '挺高';
  if (value >= 400) return '一般';
  if (value >= 250) return '偏低';
  return '很低';
}

/**
 * 5 轴的定性描述（写进提示词）。
 *
 * ★ 为什么不给数字：模型看到「喜欢 780 / 信任 680」会不自觉地把它当成
 *   角色属性面板来「演」，也偶尔会把数字说出来。只给程度词既保留标定信息，
 *   又不那么像在读数据。数值只在 /api/admin/relation 里看。
 */
export function describeFacetsQualitative(f: RelationFacets): string {
  return `喜欢${degreeWord(f.affection)}、信任${degreeWord(f.trust)}、尊重${degreeWord(
    f.respect,
  )}、心动${degreeWord(f.attraction)}、熟悉${degreeWord(f.intimacy)}`;
}
