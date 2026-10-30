/**
 * 脾气：由情绪向量推导「这一轮愿不愿意配合」。
 *
 * 为什么需要它：
 * 情绪向量只影响「语气」，不影响「答不答应」。所以哪怕 grievance 很高，
 * 她也只是"委屈地答应"，本质仍然是有求必应——这不是脾气，是讨好。
 *
 * 这里把情绪换算成一个 0~1 的配合度，并给出可执行的行为许可：
 * 冷淡 / 拒绝 / 让他先哄。
 */
import type { EmotionVector } from './emotion-vector';
import type { RelationFacets } from './relation-facets';

export type TemperStance = "warm" | "steady" | "cool" | "cold";

export interface Temper {
  stance: TemperStance;
  /** 0~1：这一轮有多愿意配合 */
  compliance: number;
  /** 是否允许直接拒绝 */
  allowRefuse: boolean;
  /** 写进提示词的行为指令 */
  line: string;
}

export interface TemperInput {
  vector: EmotionVector;
  facets: RelationFacets;
  wasIgnored?: boolean;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/** 纯函数：情绪 → 配合度与行为许可。 */
export function computeTemper(input: TemperInput): Temper {
  const { vector, facets } = input;
  const grievance = Math.max(0, vector.grievance);
  const fatigue = Math.max(0, vector.fatigue);
  // 亲密度高时更容易心软；但委屈和疲惫会强烈压低配合度。
  const warmth = clamp01(facets.intimacy / 100);
  let compliance = 0.55;
  compliance += (vector.valence / 100) * 0.25;
  compliance += (vector.attachment / 100) * 0.12;
  compliance += warmth * 0.1;
  compliance -= (grievance / 100) * 0.7;
  compliance -= (fatigue / 100) * 0.2;
  if (vector.dominance < 0) compliance -= (Math.abs(vector.dominance) / 100) * 0.15;
  if (input.wasIgnored) compliance -= 0.1;
  compliance = clamp01(compliance);

  const stance: TemperStance =
    compliance >= 0.75 ? "warm" : compliance >= 0.5 ? "steady" : compliance >= 0.3 ? "cool" : "cold";

  // 生气到一定程度就可以直接拒绝；只是"不太热情"不许拿来挡正常请求。
  const allowRefuse = grievance >= 35 || compliance < 0.32;

  const line =
    stance === "cold"
      ? "你现在不想配合：可以明确拒绝、可以说「不想」「一会儿再说」，也可以只回一两个字。不要因为怕他不高兴就改口。"
      : stance === "cool"
        ? "你有点不痛快：可以敷衍、可以少说、可以让他先哄你；非必要不主动讨好。"
        : stance === "steady"
          ? "你状态平常：愿意就答应，不愿意就直接说，不用勉强。"
          : "你心情不错：可以主动一点、多给一点反应，但依然可以不答应。";

  return { stance, compliance: Number(compliance.toFixed(2)), allowRefuse, line };
}