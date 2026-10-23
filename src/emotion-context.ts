/**
 * 情感系统的运行时编排：读 KV → 抽事件 → 更新情绪向量 / 5 轴增量 → 存 KV → 出快照。
 *
 * 存储位置：KV（`emotion:state`），**不写 memory.md**。
 * 原因：memory.md 有 12KB 硬预算，情绪是高频易变的临时数据，挤进去会挤掉长期记忆。
 * memory.md 里只保留每日结算后的 5 个整数（喜欢 / 信任 / 尊重 / 心动 / 熟悉）。
 *
 * 成本控制：
 * - 聊天关键路径上**只跑规则**（零请求、零延迟）；Workers AI 复核只在每日任务里跑
 * - KV 写入前做脏检查：这一轮没抽到事件、向量也没变，就不写
 */

import type { Env } from './types';
import {
  applyEnvironmentToEmotion,
  decayEmotion,
  decayGrievanceDaily,
  emptyEmotionVector,
  parseEmotionVector,
  type EmotionVector,
} from './emotion-vector';
import {
  applyEventsToVector,
  extractEmotionEvents,
  needsAiEventReview,
  reconcileWithApology,
  reviewEventsWithAI,
  sumFacetDelta,
  unresolvedEvents,
  type EmotionEvent,
} from './emotion-events';
import {
  applyFacetDelta,
  clampFacet,
  facetsFromValues,
  relationArchetype,
  settleFacetDelta,
  FACET_KEYS,
  type FacetKey,
  type RelationFacets,
} from './relation-facets';
import { buildEmotionSnapshot } from './emotion-snapshot';
import type { MoodEnvironment } from './mood-env';

const STATE_KEY = 'emotion:state';
const STATE_TTL_SECONDS = 90 * 24 * 60 * 60;
/** 事件池上限：够撑一周的小情绪，又不至于把 KV 撑大。 */
const MAX_EVENTS = 30;

export type FacetAccum = Partial<Record<FacetKey, number>>;

export interface EmotionState {
  vector: EmotionVector;
  events: EmotionEvent[];
  /** 自上次每日结算以来累积的 5 轴浮点增量 */
  facetDelta: FacetAccum;
  /** 上次更新时间（epoch ms） */
  at: number;
}

export function emptyEmotionState(now: number): EmotionState {
  return { vector: emptyEmotionVector(), events: [], facetDelta: {}, at: now };
}

function sanitizeEvents(raw: unknown): EmotionEvent[] {
  if (!Array.isArray(raw)) return [];
  const out: EmotionEvent[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const e = item as Partial<EmotionEvent>;
    if (typeof e.type !== 'string' || typeof e.at !== 'number') continue;
    out.push({
      type: e.type as EmotionEvent['type'],
      intensity: (e.intensity === 3 ? 3 : e.intensity === 2 ? 2 : 1) as 1 | 2 | 3,
      target: e.target === 'ai' || e.target === 'world' ? e.target : 'user',
      evidence: typeof e.evidence === 'string' ? e.evidence.slice(0, 20) : '',
      at: e.at,
      resolved: e.resolved === true,
    });
  }
  return out.slice(-MAX_EVENTS);
}

function sanitizeFacetDelta(raw: unknown): FacetAccum {
  const out: FacetAccum = {};
  if (!raw || typeof raw !== 'object') return out;
  const obj = raw as Record<string, unknown>;
  for (const key of FACET_KEYS) {
    const n = Number(obj[key]);
    if (Number.isFinite(n) && n !== 0) out[key] = n;
  }
  return out;
}

/** 读取状态，并按「距上次多久」做时间衰减。 */
export async function loadEmotionState(env: Env, now: number): Promise<EmotionState> {
  try {
    const raw = await env.KV.get(STATE_KEY);
    if (!raw) return emptyEmotionState(now);
    const parsed = JSON.parse(raw) as Partial<EmotionState>;
    const at = typeof parsed.at === 'number' ? parsed.at : now;
    const elapsedMin = Math.max(0, (now - at) / 60000);
    return {
      vector: decayEmotion(parseEmotionVector(parsed.vector), elapsedMin),
      events: sanitizeEvents(parsed.events),
      facetDelta: sanitizeFacetDelta(parsed.facetDelta),
      at,
    };
  } catch {
    return emptyEmotionState(now);
  }
}

export async function saveEmotionState(env: Env, state: EmotionState): Promise<void> {
  const payload = JSON.stringify({
    vector: state.vector,
    events: state.events.slice(-MAX_EVENTS),
    facetDelta: state.facetDelta,
    at: state.at,
  });
  await env.KV.put(STATE_KEY, payload, { expirationTtl: STATE_TTL_SECONDS }).catch((e) => {
    console.error('[emotion] 保存状态失败:', e);
  });
}

/** 清空（测试 / 重置用）。 */
export async function resetEmotionState(env: Env): Promise<void> {
  await env.KV.delete(STATE_KEY).catch(() => {});
}

export interface EmotionTurnInput {
  env: Env;
  now: number;
  /** memory.md 里的基准 5 轴（整数） */
  base: RelationFacets;
  /** 本轮用户消息 */
  userText: string;
  /** 环境（时段/天气/季节/节假日），用于「它自己」的情绪来源 */
  environment?: MoodEnvironment | null;
  /** 上次主动消息被冷落 */
  wasIgnored?: boolean;
  /** 是否允许在关键路径调 Workers AI（默认关闭，避免拖慢首字延迟） */
  allowAiReview?: boolean;
}

export interface EmotionTurnResult {
  state: EmotionState;
  /** 叠加轮级增量后的有效 5 轴 */
  facets: RelationFacets;
  /** 结构化情绪状态（调试用） */
  snapshot: string;
}

/** 把「基准 5 轴 + 累积增量」合成本轮生效值。 */
export function effectiveFacets(base: RelationFacets, delta: FacetAccum): RelationFacets {
  const out = { ...base };
  for (const key of FACET_KEYS) {
    out[key] = clampFacet(base[key] + (delta[key] ?? 0));
  }
  return out;
}

function addFacetDelta(target: FacetAccum, src: Partial<Record<FacetKey, number>>): void {
  for (const key of FACET_KEYS) {
    const d = src[key];
    if (!d) continue;
    target[key] = (target[key] ?? 0) + d;
  }
}

/**
 * 处理一轮对话的情感变化（聊天三通道共用）。
 *
 * 注意：这里只更新 KV 里的运行时状态，**不写 memory.md**；
 * memory.md 的整数由每日任务统一结算（见 settleEmotionDaily）。
 */
export async function processEmotionTurn(input: EmotionTurnInput): Promise<EmotionTurnResult> {
  const { now, base, userText, environment, wasIgnored } = input;
  const state = await loadEmotionState(input.env, now);
  const prevVector = state.vector;

  // ① 抽本轮事件（规则；关键路径默认不调 AI）
  let newEvents = extractEmotionEvents(userText ?? '', now);
  if (input.allowAiReview && newEvents.length === 0 && (userText ?? '').trim()) {
    const aiEvents = await reviewEventsWithAI(input.env, userText, now);
    if (aiEvents.length > 0) newEvents = aiEvents;
  }
  if (wasIgnored) {
    newEvents = [
      ...newEvents,
      {
        type: 'ignored',
        intensity: 1,
        target: 'ai',
        evidence: '上次主动找他没回',
        at: now,
        resolved: false,
      },
    ];
  }

  const allEvents = reconcileWithApology([...state.events, ...newEvents], now);

  // ② 情绪向量：事件驱动 + 环境自发（按间隔折算，避免连聊几十轮把值推满）
  let vector = applyEventsToVector(state.vector, newEvents);
  const elapsedMin = Math.max(0, (now - state.at) / 60000);
  if (environment) {
    const envFactor = Math.min(1, elapsedMin / 180);
    if (envFactor > 0) {
      const withEnv = applyEnvironmentToEmotion(vector, environment);
      vector = scaleToward(vector, withEnv, envFactor);
    }
  }

  // ③ 5 轴轮级增量
  const facetDelta = { ...state.facetDelta };
  if (newEvents.length > 0) addFacetDelta(facetDelta, sumFacetDelta(newEvents));

  const nextState: EmotionState = {
    vector,
    events: allEvents.slice(-MAX_EVENTS),
    facetDelta,
    at: now,
  };

  // ④ 脏检查：没有新事件、向量也没变 → 不写 KV
  const changed = newEvents.length > 0 || vectorChanged(prevVector, vector);
  if (changed) await saveEmotionState(input.env, nextState);

  const facets = effectiveFacets(base, facetDelta);
  return {
    state: nextState,
    facets,
    snapshot: buildEmotionSnapshot({
      facets,
      vector,
      events: nextState.events,
      now,
      wasIgnored,
    }),
  };
}

function vectorChanged(a: EmotionVector, b: EmotionVector): boolean {
  return JSON.stringify(a) !== JSON.stringify(b);
}

/** 按比例把 a 拉向 b（用于按已经过的时间折算环境漂移）。 */
function scaleToward(a: EmotionVector, b: EmotionVector, factor: number): EmotionVector {
  const f = Math.min(1, Math.max(0, factor));
  const out = { ...a };
  for (const key of Object.keys(a) as Array<keyof EmotionVector>) {
    out[key] = Math.round(a[key] + (b[key] - a[key]) * f);
  }
  return out;
}

export interface EmotionSettleResult {
  /** 结算后的 5 轴（整数，应写回 memory.md） */
  facets: RelationFacets;
  /** 本次实际写入的增量 */
  applied: Required<Record<FacetKey, number>>;
  /** 是否真的有变化 */
  changed: boolean;
}

/**
 * 每日结算：把累积的浮点增量取整、按单日上限截断，合进 memory.md 的五轴。
 * 结算成功后清空累积器（事件池保留，未化解的芥蒂要跨天）。
 */
export function settleEmotionDaily(state: EmotionState, base: RelationFacets): EmotionSettleResult {
  const applied = settleFacetDelta(state.facetDelta);
  const facets = { ...base };
  let changed = false;
  for (const key of FACET_KEYS) {
    if (applied[key] === 0) continue;
    facets[key] = clampFacet(base[key] + applied[key]);
    if (facets[key] !== base[key]) changed = true;
  }
  return { facets, applied, changed };
}

/** 每日：芥蒂按 20% 退，事件池裁到上限，清空增量累积器。 */
export async function commitEmotionSettle(env: Env, state: EmotionState): Promise<void> {
  const now = Date.now();
  await saveEmotionState(env, {
    vector: decayGrievanceDaily(state.vector),
    events: state.events.slice(-MAX_EVENTS),
    facetDelta: {},
    at: now,
  });
}

/**
 * 每日归档时用 Workers AI 复核当天消息（补词典漏检）。
 *
 * 只对「有歧义」的消息调用：否定 / 反讽 / 正负冲突。
 * 单日最多 8 条，避免把一个月的免费额度烧在某一天。
 */
export async function reviewDayEvents(
  env: Env,
  texts: string[],
  at: number,
): Promise<EmotionEvent[]> {
  const out: EmotionEvent[] = [];
  let calls = 0;
  for (const text of texts) {
    if (calls >= 8) break;
    const t = (text ?? '').trim();
    if (t.length < 4) continue;
    const rule = extractEmotionEvents(t, at);
    if (!needsAiEventReview(t, rule)) continue;
    calls += 1;
    const ai = await reviewEventsWithAI(env, t, at);
    for (const e of ai) out.push({ ...e, evidence: t.slice(0, 20) });
  }
  return out;
}

/** 调试：当前未化解的芥蒂。 */
export function listOpenGrievances(state: EmotionState, now: number): EmotionEvent[] {
  return unresolvedEvents(state.events, now, 7 * 86400_000, 2);
}

/** 调试：当前关系原型。 */
export function currentArchetype(facets: RelationFacets, vector: EmotionVector) {
  return relationArchetype(facets, Math.max(0, vector.grievance));
}

/** 兼容旧调用：把 memory.md 的三值转成 5 轴。 */
export function facetsOf(values: { affinity: number; intimacy: number; trust?: number; respect?: number; attraction?: number }): RelationFacets {
  return facetsFromValues(values);
}

export interface EmotionSimulationStep {
  text: string;
  events: EmotionEvent[];
  vector: EmotionVector;
  snapshot: string;
}

/**
 * 纯函数模拟：喂一串用户消息，逐步算出情绪演化与快照。
 *
 * 不读写 KV、不影响线上状态，用于调阈值（admin/emotion/simulate 与本地调试共用）。
 */
export function simulateEmotion(
  texts: string[],
  facets: RelationFacets,
  now: number,
  gapMs = 60_000,
): { steps: EmotionSimulationStep[]; final: string; events: EmotionEvent[] } {
  let vector = emptyEmotionVector();
  const events: EmotionEvent[] = [];
  const steps: EmotionSimulationStep[] = [];

  for (let i = 0; i < texts.length; i++) {
    const at = now + i * gapMs;
    const fresh = extractEmotionEvents(texts[i], at);
    const merged = reconcileWithApology([...events, ...fresh], at);
    events.length = 0;
    events.push(...merged.slice(-MAX_EVENTS));
    // 每一步之间按 gapMs 自然衰减，模拟真实聊天节奏
    vector = applyEventsToVector(decayEmotion(vector, gapMs / 60000), fresh);
    steps.push({
      text: texts[i],
      events: fresh,
      vector: { ...vector },
      snapshot: buildEmotionSnapshot({ facets, vector, events, now: at }),
    });
  }

  const endAt = now + texts.length * gapMs;
  return {
    steps,
    final: buildEmotionSnapshot({ facets, vector, events, now: endAt }),
    events,
  };
}
