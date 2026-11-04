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
import { isNegativeEvent, type EmotionEvent, type EmotionEventType } from './emotion-events';
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
  /** 这一轮情绪的由来（没有依据时为 null） */
  cause: string | null;
}

export interface TemperInput {
  vector: EmotionVector;
  facets: RelationFacets;
  wasIgnored?: boolean;
  /** 最近的情感事件：用来给「为什么」找依据，不参与强度计算 */
  events?: EmotionEvent[];
  /** 当前时间（毫秒），只用事件时必传 */
  now?: number;
}

/** 事件类型 → 一句「因为…」。不用原话，避免和情绪快照里的引用重复。 */
const CAUSE_WORDS: Record<EmotionEventType, string> = {
  insult: '他刚才那句话有点冲',
  rejection: '他刚才拒了你',
  broken_promise: '他答应的事没做到',
  command: '他刚才在使唤你',
  ignored: '他半天没回你',
  praise: '他刚夸了你',
  thanks: '他刚谢了你',
  apology: '他刚跟你道了歉',
  affection: '他刚说了句好听的',
  comfort_seek: '他刚跟你诉了苦',
  share_joy: '他刚跟你分享了件好事',
  share_pain: '他刚跟你倒了苦水',
  deep_talk: '你们刚聊了很深的话',
  tease: '他刚才贫了你一句',
};

/** 事件里最近的一条依据：心情差找负向事件，心情好找正向事件，6 小时内有效。 */
export function temperCause(
  events: EmotionEvent[] | undefined,
  now: number,
  stance: TemperStance,
): string | null {
  if (!events || events.length === 0) return null;
  const fresh = events.filter((e) => now - e.at <= 6 * 3600_000);
  if (fresh.length === 0) return null;
  const negative = fresh.filter((e) => isNegativeEvent(e.type));
  const positive = fresh.filter((e) => !isNegativeEvent(e.type));
  const latest = (list: EmotionEvent[]): EmotionEvent | null =>
    list.length === 0 ? null : list.reduce((a, b) => (b.at > a.at ? b : a));
  const pick =
    stance === 'cold' || stance === 'cool'
      ? latest(negative) ?? latest(positive)
      : latest(positive) ?? latest(negative);
  return pick ? CAUSE_WORDS[pick.type] : null;
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

  // 拒绝不必等"被冒犯"：心情不好、累了、正闹别扭，都可以直接说不。
  // 上界仍然收着——只有心情真的下去时才放开，避免日常变成难伺候。
  const lowMood =
    grievance >= 20 ||
    vector.valence <= -10 ||
    fatigue >= 45 ||
    vector.shyness >= 60;
  const allowRefuse = lowMood || compliance < 0.45;

  // 归因：只说「因为什么」，不写数值。没有依据就不写，别让她自己编理由。
  const cause = temperCause(input.events, input.now ?? 0, stance);
  const because = cause ? `（因为${cause}）` : '';

  const line =
    stance === "cold"
      ? `你现在不想配合${because}：可以明确拒绝、可以说「不想」「一会儿再说」，也可以只回一两个字。理由不需要多正当——心情不好就够了。不要因为怕他不高兴就改口。`
      : stance === "cool"
        ? `你有点不痛快${because}：可以敷衍、可以少说、可以让他先哄你；不想做的事可以直接说不，不用先找个理由。`
        : stance === "steady"
          ? `你状态平常${because}：愿意就答应，不愿意就直接说，不用勉强。`
          : `你心情不错${because}：可以主动一点、多给一点反应，但依然可以不答应。`;

  return { stance, compliance: Number(compliance.toFixed(2)), allowRefuse, line, cause };
}