/**
 * 性格的缓慢漂移（潜移默化，不重写人物底色）。
 *
 * 设计底线：
 * - 人物底色/称呼/雷区/价值观永远由 memory.md 的核心层提供，绝不由这里改；
 * - 这里只维护 6 个“可漂移”的性格维度，每次最多 ±2，上下限受基线约束；
 * - 至少积累 7 天、15 条用户消息才结算一次，避免单日情绪带偏；
 * - 状态存 KV（persona:state），只影响提示词里的“近期倾向”，不写 memory.md；
 * - 变化不主动告诉用户，也不让模型刻意表演。
 */
import type { Env } from './types';
import { distillText } from './distill';
import { dateKeyInBeijing } from './date';

export const TRAIT_KEYS = ['傲娇', '活泼', '黏人', '大大咧咧', '温柔', '毒舌'] as const;
export type TraitKey = (typeof TRAIT_KEYS)[number];
export type TraitValues = Record<TraitKey, number>;

export const BASELINE: TraitValues = {
  傲娇: 78,
  活泼: 76,
  黏人: 70,
  大大咧咧: 66,
  温柔: 60,
  毒舌: 32,
};

const MIN_VALUE = 30;
const MAX_VALUE = 95;
const MAX_DELTA = 2; // 每次结算每个维度最多 ±2
const REVIEW_INTERVAL_DAYS = 7;
const MIN_USER_MESSAGES = 15;
const STATE_KV = 'persona:state';

export interface PersonaState {
  values: TraitValues;
  baseline: TraitValues;
  updatedAt: string;
  lastReview: string; // 上次结算日期 YYYY-MM-DD
  history: Array<{ date: string; deltas: Partial<TraitValues>; note: string }>;
}

function clampTrait(key: TraitKey, value: number, baseline: TraitValues): number {
  // 允许在基线上下的有限范围内漂移，越接近边界越难再变
  const floor = Math.max(MIN_VALUE, baseline[key] - 14);
  const ceil = Math.min(MAX_VALUE, baseline[key] + 14);
  return Math.min(ceil, Math.max(floor, Math.round(value)));
}

function parseState(raw: unknown): PersonaState | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Partial<PersonaState>;
  if (!obj.values || typeof obj.values !== 'object') return null;
  const values = {} as TraitValues;
  for (const k of TRAIT_KEYS) values[k] = Number((obj.values as TraitValues)[k] ?? BASELINE[k]);
  return {
    values,
    baseline: BASELINE,
    updatedAt: typeof obj.updatedAt === 'string' ? obj.updatedAt : new Date().toISOString(),
    lastReview: typeof obj.lastReview === 'string' ? obj.lastReview : dateKeyInBeijing(),
    history: Array.isArray(obj.history) ? obj.history.slice(-12) : [],
  };
}

export async function loadPersonaState(env: Env): Promise<PersonaState> {
  try {
    const raw = (await env.KV.get(STATE_KV, 'json')) as unknown;
    const parsed = parseState(raw);
    if (parsed) return parsed;
  } catch {
    /* fallthrough */
  }
  // 首次初始化：把 lastReview 设为今天，先观察 7 天真实对话再动
  const fresh: PersonaState = {
    values: { ...BASELINE },
    baseline: { ...BASELINE },
    updatedAt: new Date().toISOString(),
    lastReview: dateKeyInBeijing(),
    history: [],
  };
  await env.KV.put(STATE_KV, JSON.stringify(fresh)).catch(() => {});
  return fresh;
}

/** 给提示词用的一句话：只描述“最近轻微倾向”，不暴露数值、不要求表演。 */
export function buildPersonaDriftLine(state: PersonaState): string | null {
  const changed = TRAIT_KEYS.map((k) => ({ k, d: state.values[k] - state.baseline[k] }))
    .filter((x) => Math.abs(x.d) >= 3)
    .sort((a, b) => Math.abs(b.d) - Math.abs(a.d))
    .slice(0, 2);
  if (changed.length === 0) return null;
  const phrases = changed.map((x) => {
    const dir = x.d > 0 ? '更' : '没那么';
    return `${dir}${x.k}一点`;
  });
  return `## 近期性格倾向（潜移默化，别刻意演）\n- 最近你${phrases.join('、')}；这是慢慢变成的，不要主动提，也别一下子变个人。`;
}

/** 判断今天是否该结算（至少间隔 7 天）。 */
export function shouldReviewPersona(state: PersonaState, now: Date): boolean {
  const today = dateKeyInBeijing(now);
  if (state.lastReview === today) return false;
  const last = new Date(`${state.lastReview}T00:00:00+08:00`).getTime();
  return now.getTime() - last >= REVIEW_INTERVAL_DAYS * 86400000;
}

function clampDeltas(raw: Record<string, unknown>): Partial<TraitValues> {
  const out: Partial<TraitValues> = {};
  for (const k of TRAIT_KEYS) {
    const n = Number(raw[k]);
    if (!Number.isFinite(n) || n === 0) continue;
    const v = Math.max(-MAX_DELTA, Math.min(MAX_DELTA, Math.round(n)));
    if (v !== 0) out[k] = v;
  }
  return out;
}

function heuristicDeltas(userTexts: string[]): Partial<TraitValues> {
  const text = userTexts.join('\n');
  const count = (re: RegExp) => (text.match(re) || []).length;
  const d: Partial<TraitValues> = {};
  const add = (k: TraitKey, n: number) => {
    d[k] = (d[k] ?? 0) + n;
  };
  if (count(/谢谢|可爱|喜欢你|抱抱|摸摸/g) >= 3) {
    add('温柔', 1);
    add('黏人', 1);
  }
  if (count(/笑死|哈哈|草|乐/g) >= 3) add('活泼', 1);
  if (count(/凶|烦|滚|闭嘴|别烦/g) >= 2) {
    add('毒舌', 1);
    add('温柔', -1);
  }
  if (count(/想你|在吗|陪我|晚安/g) >= 3) add('黏人', 1);
  if (count(/哼|才不是|谁要|笨蛋/g) >= 3) add('傲娇', 1);
  if (count(/随便|都行|无所谓/g) >= 3) add('大大咧咧', 1);
  return clampDeltas(d);
}

/**
 * 每周结算一次：根据最近 7 天对话判断性格的轻微漂移。
 * 模型失败/返回非法时用确定性启发式兜底；无足够对话则跳过。
 */
export async function maybeReviewPersonaDrift(
  env: Env,
  now: Date,
): Promise<{ reviewed: boolean; deltas?: Partial<TraitValues>; reason?: string }> {
  const state = await loadPersonaState(env);
  if (!shouldReviewPersona(state, now)) return { reviewed: false, reason: '未到结算周期' };

  const since = `${state.lastReview}T00:00:00+08:00`;
  const rows = await env.DB.prepare(
    `SELECT role, content FROM messages
     WHERE created_at >= ? AND role IN ('user', 'assistant')
     ORDER BY id ASC LIMIT 400`,
  )
    .bind(since)
    .all<{ role: string; content: string }>();
  const msgs = (rows.results ?? []).filter((r) => r.content.trim());
  const userTexts = msgs.filter((r) => r.role === 'user').map((r) => r.content);
  if (userTexts.length < MIN_USER_MESSAGES) {
    return { reviewed: false, reason: `对话不足（${userTexts.length}/${MIN_USER_MESSAGES}）` };
  }

  const conversation = msgs
    .slice(-300)
    .map((m) => `${m.role === 'user' ? '用户' : '助手'}：${m.content.slice(0, 300)}`)
    .join('\n');
  const system =
    '你是角色性格演化的观察器。根据最近 7 天对话，判断角色 6 个性格维度的轻微变化。' +
    '只输出 JSON 对象，键只能是：傲娇、活泼、黏人、大大咧咧、温柔、毒舌；' +
    '每个值必须是 -2 到 2 的整数（没有变化就省略）；不要输出理由、不要输出其他文字。';
  const user = `当前性格数值（仅参考）：${TRAIT_KEYS.map((k) => `${k}=${state.values[k]}`).join('，')}\n\n最近对话：\n${conversation}`;

  let deltas: Partial<TraitValues> | null = null;
  try {
    const res = await distillText(env, system, user, 200, env.SUMMARY_DEEPSEEK_MODEL || env.DEEPSEEK_MODEL);
    const match = res.text.match(/\{[\s\S]*\}/);
    if (match) deltas = clampDeltas(JSON.parse(match[0]) as Record<string, unknown>);
  } catch (e) {
    console.warn('[persona] llm review failed, fallback heuristic:', e);
  }
  if (!deltas) deltas = heuristicDeltas(userTexts);

  const next = { ...state.values };
  for (const k of TRAIT_KEYS) {
    const d = deltas[k];
    if (d) next[k] = clampTrait(k, next[k] + d, state.baseline);
  }
  const changed = TRAIT_KEYS.some((k) => next[k] !== state.values[k]);
  const updated: PersonaState = {
    ...state,
    values: next,
    updatedAt: now.toISOString(),
    lastReview: dateKeyInBeijing(now),
    history: [
      ...state.history,
      {
        date: dateKeyInBeijing(now),
        deltas,
        note: changed ? 'weekly review' : 'no change',
      },
    ].slice(-12),
  };
  await env.KV.put(STATE_KV, JSON.stringify(updated));
  return { reviewed: true, deltas };
}
