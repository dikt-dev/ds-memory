/**
 * 情感系统的运行时编排：读 D1 runtime_state → 抽事件 → 更新情绪向量 / 5 轴增量 → 写回 → 出快照。
 *
 * 存储位置：D1 `runtime_state`（key=`emotion:state`），**不写 memory.md**。
 * D1 不可用时 runtime-store 自动回退 KV（测试/灰度安全）。
 * memory.md 里只保留每日结算后的 5 个整数（喜欢 / 信任 / 尊重 / 心动 / 熟悉）。
 *
 * 成本控制：
 * - 聊天关键路径上**只跑规则**（零请求、零延迟）；Workers AI 复核只在每日任务里跑
 * - D1 runtime_state 写入前做脏检查：这一轮没抽到事件、向量也没变，就不写
 */

import type { Env } from './types';
import { putObject } from './storage';
import { logTrace } from './trace';
import {
  acquireRuntimeLock,
  deleteRuntimeState,
  getRuntimeState,
  putRuntimeState,
  releaseRuntimeLock,
} from './runtime-store';
import { recordEmotionEvents, recordFacetDelta } from './affect-store';
import {
  applyEmotionDelta,
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
  isNegativeEvent,
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
import { logError, logWarn } from './error-log';

const STATE_KEY = 'emotion:state';
const STATE_TTL_SECONDS = 90 * 24 * 60 * 60;
/** 事件池上限：够撑一周的小情绪，又不至于把 runtime_state 撑大。 */
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
      evidence: typeof e.evidence === 'string' ? e.evidence.slice(0, 80) : '',
      at: e.at,
      resolved: e.resolved === true,
    });
  }
  return out.slice(-MAX_EVENTS);
}

/**
 * 事件池裁剪：保留最近 MAX_EVENTS 条，但**未化解的负向事件不参与裁剪**。
 *
 * 原来一律 slice(-30)：聊得多的一天就能产生 30+ 事件，旧的未化解事件被挤掉，
 * 表现为「明明在闹别扭，第二天她就当没发生过」。
 */
const MAX_OPEN_NEGATIVES = 5;
export function trimEvents(events: EmotionEvent[], max = MAX_EVENTS): EmotionEvent[] {
  const tail = events.slice(-max);
  const tailSet = new Set(tail);
  const openNegatives = events
    .filter((e) => isNegativeEvent(e.type) && e.resolved !== true && !tailSet.has(e))
    .slice(-MAX_OPEN_NEGATIVES);
  return [...openNegatives, ...tail].sort((a, b) => a.at - b.at);
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
    const raw = await getRuntimeState(env, STATE_KEY);
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
  await putRuntimeState(env, STATE_KEY, payload, STATE_TTL_SECONDS).catch((e) => {
    logError('[emotion] 保存状态失败:', e);
  });
}

/** 清空（测试 / 重置用）。 */
export async function resetEmotionState(env: Env): Promise<void> {
  await deleteRuntimeState(env, STATE_KEY).catch(() => {});
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
  /** 规则没抽出事件时也调 AI 复核（每日归档任务用；聊天路径不开，否则每条消息都调） */
  reviewEmpty?: boolean;
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
 * 注意：这里只更新 D1 runtime_state 里的运行时状态，**不写 memory.md**；
 * memory.md 的整数由每日任务统一结算（见 settleEmotionDaily）。
 */
/**
 * 情感状态的并发保护。
 *
 * 原来 load→改→save 没有锁：两个渠道同时发消息时，后写的会用旧状态覆盖前一个，
 * 整轮情绪事件凭空消失（App + 网页同时在线、手机重发都会触发）。
 */
const EMOTION_LOCK = 'emotion:lock';
const EMOTION_LOCK_TTL = 10;

export async function processEmotionTurn(input: EmotionTurnInput): Promise<EmotionTurnResult> {
  // 只有「这一轮可能真的产生事件」时才加锁：普通闲聊不加锁，
  // 否则每条消息都要额外两次 KV 写（锁 + 解锁），免费额度扛不住。
  const mayWrite =
    input.wasIgnored === true || extractEmotionEvents(input.userText ?? '', input.now).length > 0;
  if (!mayWrite) return processEmotionTurnUnlocked(input, true);
  const locked = await acquireRuntimeLock(input.env, EMOTION_LOCK, EMOTION_LOCK_TTL);
  if (!locked) {
    // 拿不到锁：照常算，但不写状态。宁可这一轮不记账，也不要覆盖别人的结果。
    return processEmotionTurnUnlocked(input, false);
  }
  try {
    return await processEmotionTurnUnlocked(input, true);
  } finally {
    await releaseRuntimeLock(input.env, EMOTION_LOCK).catch(() => {});
  }
}

async function processEmotionTurnUnlocked(
  input: EmotionTurnInput,
  canSave: boolean,
): Promise<EmotionTurnResult> {
  const { now, base, userText, environment, wasIgnored } = input;
  const state = await loadEmotionState(input.env, now);
  const prevVector = state.vector;

  // ① 抽本轮事件（规则；关键路径默认不调 AI）
  let newEvents = extractEmotionEvents(userText ?? '', now);
  // 规则判出负向事件时也要复核：误判成「真生气」的代价不对称——
  // 她会对一句玩笑莫名其妙发火；反过来漏判只是没反应，代价小得多。
  const hasNegative = newEvents.some((e) => isNegativeEvent(e.type));
  if (input.allowAiReview && (userText ?? "").trim() && (hasNegative || input.reviewEmpty === true)) {
    try {
      const aiEvents = await reviewEventsWithAI(input.env, userText, now);
      if (hasNegative) {
        const aiHasNegative = aiEvents.some((e) => isNegativeEvent(e.type));
        if (aiHasNegative) {
          newEvents = [...newEvents.filter((e) => !isNegativeEvent(e.type)), ...aiEvents];
        } else {
          // AI 说这不是真的冒犯 → 降级成玩笑，不留委屈
          newEvents = newEvents.map((e) =>
            isNegativeEvent(e.type)
              ? { ...e, type: 'tease' as const, intensity: 1 as const, resolved: true }
              : e,
          );
        }
      } else if (aiEvents.length > 0) {
        newEvents = aiEvents;
      }
    } catch {
      // 复核失败就按规则来，不影响回复
    }
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
  // 长聊也会累：间隔越久（同一次对话内）越接近「聊久了」，每 30 分钟补 3 点，
  // 单轮最多 6 点，睡着的时候由环境漂移接管。
  if (elapsedMin >= 15 && state.vector.fatigue < 80) {
    const chatFatigue = Math.min(6, Math.round(elapsedMin / 30) * 3);
    if (chatFatigue > 0) vector = applyEmotionDelta(vector, { fatigue: chatFatigue });
  }
  if (environment) {
    const envFactor = Math.min(1, elapsedMin / 180);
    if (envFactor > 0) {
      const withEnv = applyEnvironmentToEmotion(vector, environment);
      vector = scaleToward(vector, withEnv, envFactor);
    }
  }

  // ③ 5 轴轮级增量
  const facetDelta = { ...state.facetDelta };
  if (newEvents.length > 0) {
    const turnDelta = sumFacetDelta(newEvents);
    addFacetDelta(facetDelta, turnDelta);
    // Phase 3：事件与关系增量写入 D1 账本；失败不影响聊天。
    await recordEmotionEvents(input.env, newEvents);
    await recordFacetDelta(input.env, turnDelta, newEvents[0]?.evidence ?? '', now);
  }

  const nextState: EmotionState = {
    vector,
    events: trimEvents(allEvents),
    facetDelta,
    at: now,
  };

  // ④ 脏检查：没有新事件、向量也没变 → 不写 D1
  const changed = newEvents.length > 0 || vectorChanged(prevVector, vector);
  if (changed && canSave) await saveEmotionState(input.env, nextState);

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

/**
 * 错过几天结算：04:00 没跑到（部署、报错、手动补跑）时，芥蒂不能原地冻着。
 *
 * 只重放「每日衰减」这一件确定性的事；增量累积器本来就是按天取整的，
 * 多日累积会在下一次结算一次性截断到单日上限，不会爆表。
 */
export function missedSettleRounds(
  lastAt: number,
  now: number,
  max = 7,
): number {
  if (!Number.isFinite(lastAt) || lastAt <= 0) return 0;
  const days = Math.floor((now - lastAt) / 86_400_000);
  return Math.max(0, Math.min(max, days));
}

/**
 * 芥蒂联动关系轴：委屈高时轻微扣信任。
 *
 * 原来的账是两套：她「记着仇」，但 trust 一分不掉，时间一长就变成
 * 嘴上闹别扭、数值上毫无代价。这里按委屈程度给一个每天最多 -2 的惩罚，
 * 既留得住芥蒂，也不至于一次吵架把信任打穿。
 */
export function grievanceTrustPenalty(vector: EmotionVector): number {
  const g = Math.max(0, vector.grievance);
  if (g < 20) return 0;
  return -Math.min(2, Math.round((g / 100) * 3 * 10) / 10);
}

/**
 * 每日：芥蒂按 20% 退，事件池裁到上限，清空增量累积器。
 *
 * catchUp=true 时把「漏跑的天数」补上——只有每日归档那条链路会打开它，
 * 聊天里的即时结算仍然是单次，避免一次交互把芥蒂多退几轮。
 */
export async function commitEmotionSettle(
  env: Env,
  state: EmotionState,
  opts: { catchUp?: boolean } = {},
): Promise<number> {
  const now = Date.now();
  const rounds = opts.catchUp ? 1 + missedSettleRounds(state.at, now) : 1;
  let vector = state.vector;
  for (let i = 0; i < rounds; i++) vector = decayGrievanceDaily(vector);
  await saveEmotionState(env, {
    vector,
    events: trimEvents(state.events),
    facetDelta: {},
    at: now,
  });
  if (rounds > 1) {
    logTrace('emotion.settle.catchup', { rounds, lastAt: state.at });
  }
  return rounds;
}

/** 情绪日线：每天存一份向量，供趋势查看与复盘（memory/emotion-history/YYYY-MM-DD.json）。 */
export async function saveEmotionHistory(
  env: Env,
  dateKey: string,
  data: { vector: EmotionVector; facets: RelationFacets; mood: number },
): Promise<boolean> {
  try {
    await putObject(
      env,
      `memory/emotion-history/${dateKey}.json`,
      JSON.stringify({ date: dateKey, ...data, at: Date.now() }),
      { contentType: 'application/json' },
    );
    return true;
  } catch (e) {
    logError('[emotion] 日线写入失败:', e);
    return false;
  }
}

/**
 * 每日归档时用 Workers AI 复核当天消息（补词典漏检）。
 *
 * 只对「有歧义」的消息调用：否定 / 反讽 / 正负冲突。
 * 单日最多 40 条（原来是 8 条，那是 Workers AI 免费额度时代的限制，长对话会大量漏检）。
 */
export async function reviewDayEvents(
  env: Env,
  texts: string[],
  at: number,
): Promise<EmotionEvent[]> {
  const out: EmotionEvent[] = [];
  let calls = 0;
  for (const text of texts) {
    if (calls >= 40) break;
    const t = (text ?? '').trim();
    if (t.length < 4) continue;
    const rule = extractEmotionEvents(t, at);
    if (!needsAiEventReview(t, rule)) continue;
    calls += 1;
    const ai = await reviewEventsWithAI(env, t, at);
    for (const e of ai) out.push({ ...e, evidence: t.slice(0, 80) });
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
 * 不读写 D1 runtime_state、不影响线上状态，用于调阈值（admin/emotion/simulate 与本地调试共用）。
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
