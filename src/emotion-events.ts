/**
 * 情感事件层。
 *
 * 为什么需要它：
 * 原来只有「好感度 ±5」这种数字，没有**凭证**。于是 AI 不会因为「你刚才说我笨」
 * 而真的介意，也不会因为你道歉而真的释怀——情绪没有因果，就显得假。
 *
 * 事件 = 带类型 / 强度 / 对象 / 原话的一条凭证。
 *   type: praise | thanks | apology | comfort_seek | affection | tease | command
 *         | rejection | insult | broken_promise | share_joy | share_pain
 *         | deep_talk | ignored
 *   intensity: 1 轻 / 2 中 / 3 重
 *   target: 冲谁来的（ai / user / world）
 *   evidence: 原话片段（≤20 字），提示词里会直接引用，让「为什么」有据可查
 *
 * 抽取策略（严格控成本）：
 * - 规则词典优先，零成本、零延迟、可单测，覆盖高频 80%
 * - 只有命中否定 / 反讽 / 正负冲突这类「词典可能判反」的情况，才在**每日任务**里
 *   让 Workers AI 复核一次（不在聊天关键路径上串行调用，避免拖慢首字延迟）
 */

import type { Env } from './types';
import { EMOTION_MAX_STEP_PER_TURN, applyEmotionDelta, type EmotionVector } from './emotion-vector';

export type EmotionEventType =
  | 'praise'
  | 'thanks'
  | 'apology'
  | 'comfort_seek'
  | 'affection'
  | 'tease'
  | 'command'
  | 'rejection'
  | 'insult'
  | 'broken_promise'
  | 'share_joy'
  | 'share_pain'
  | 'deep_talk'
  | 'ignored';

export type EventTarget = 'ai' | 'user' | 'world';

export interface EmotionEvent {
  type: EmotionEventType;
  intensity: 1 | 2 | 3;
  target: EventTarget;
  /** 原话片段（≤20 字），用于提示词里给「原因」 */
  evidence: string;
  /** epoch 毫秒 */
  at: number;
  /** 负向事件是否已被道歉/补偿化解 */
  resolved?: boolean;
}

/** 负向事件：未化解时会一直挂在「心里记着」。 */
export const NEGATIVE_EVENT_TYPES: EmotionEventType[] = [
  'insult',
  'rejection',
  'broken_promise',
  'command',
  'ignored',
];

export function isNegativeEvent(type: EmotionEventType): boolean {
  return NEGATIVE_EVENT_TYPES.includes(type);
}

interface Rule {
  type: EmotionEventType;
  words: string[];
  intensity: 1 | 2 | 3;
  target: EventTarget;
  /** 强规则：即使句子里出现否定词也照记（如「你答应我的又忘了」里的「不」） */
  strong?: boolean;
}

/**
 * 词典顺序 = 优先级。一条消息最多产出 3 个事件，
 * 避免「今天真是太谢谢你了哈哈哈哈」被拆成四五个事件刷屏。
 */
const RULES: Rule[] = [
  {
    type: 'insult',
    intensity: 3,
    target: 'ai',
    words: ['你懂什么', '没用', '废物', '垃圾', '闭嘴', '滚', '蠢', '傻逼', '笨死了', '烦不烦', '你有病'],
  },
  {
    type: 'apology',
    intensity: 2,
    target: 'ai',
    words: ['对不起', '我错了', '抱歉', '别生气', '是我不好', '不好意思', '原谅我', '我道歉'],
  },
  {
    type: 'broken_promise',
    intensity: 3,
    target: 'ai',
    words: ['说好的', '答应我的', '又忘了', '又鸽', '你不是说', '放鸽子'],
    strong: true,
  },
  {
    type: 'rejection',
    intensity: 2,
    target: 'ai',
    words: ['不想聊这个', '别问这个', '换个话题', '别说这个', '不想说', '算了不说', '别问了', '不想提'],
  },
  {
    type: 'affection',
    intensity: 2,
    target: 'ai',
    words: ['想你', '喜欢你', '爱你', '抱抱', '亲亲', '陪我', '别走', '在等你'],
  },
  {
    type: 'praise',
    intensity: 2,
    target: 'ai',
    words: ['厉害', '好棒', '真棒', '聪明', '太强', '靠谱', '优秀', '牛啊', '你真好', '好可爱', '真不错', '很不错', '做得好', '写得好', '说得好'],
  },
  {
    type: 'thanks',
    intensity: 1,
    target: 'ai',
    words: ['谢谢', '感谢', '辛苦了', '麻烦你了', '多谢', '谢啦'],
  },
  {
    type: 'comfort_seek',
    intensity: 2,
    target: 'user',
    words: ['安慰我', '陪陪我', '抱一下', '想找人说说', '我难受', '我不开心'],
  },
  {
    type: 'share_pain',
    intensity: 2,
    target: 'user',
    words: ['难过', '想哭', '崩溃', '焦虑', '压力大', '压力好大', '压力很大', '压力', '好累', '很累', '有点累', '太累', '累了', '心累', '累死', '累到', '失眠', '被骂', '被说', '搞砸', '分手', '委屈'],
  },
  {
    type: 'share_joy',
    intensity: 1,
    target: 'user',
    words: ['太好了', '开心', '搞定', '通过了', '成功了', '赢了', '爽', '舒服'],
  },
  {
    type: 'deep_talk',
    intensity: 2,
    target: 'user',
    words: ['其实我', '说实话', '我一直', '从来没跟人说', '偷偷告诉你', '只跟你说'],
  },
  {
    type: 'tease',
    intensity: 1,
    target: 'ai',
    words: ['哈哈哈', '笑死', '笨蛋', '傻子', '嫌弃你', '嫌弃', '小笨蛋'],
  },
  {
    type: 'command',
    intensity: 1,
    target: 'ai',
    words: ['快去', '给我', '马上', '赶紧', '别废话'],
  },
];

/** 否定词：命中时词典结果大概率是反的。 */
const NEGATION_WORDS = ['不', '没', '别', '无', '非', '未'];

/** 反讽/无语信号：词典几乎必定误判为正面。 */
const IRONY_HINTS = ['离谱', '无语', '服了', '真的会谢', '呵呵', '绝了', '不愧是'];

/** 一条消息最多产出的事件数。 */
const MAX_EVENTS_PER_MESSAGE = 3;

/** 取词所在的整句（用于 evidence）。 */
function sentenceOf(text: string, word: string): string {
  const idx = text.indexOf(word);
  if (idx === -1) return text.slice(0, 20);
  const start = Math.max(
    text.lastIndexOf('。', idx) + 1,
    text.lastIndexOf('！', idx) + 1,
    text.lastIndexOf('？', idx) + 1,
    text.lastIndexOf('\n', idx) + 1,
    0,
  );
  const ends = ['。', '！', '？', '!', '?', '\n']
    .map((p) => text.indexOf(p, idx))
    .filter((i) => i !== -1);
  const end = ends.length > 0 ? Math.min(...ends) : text.length;
  const sentence = text.slice(start, Math.max(end, idx + word.length)).trim();
  return (sentence || word).slice(0, 20);
}

/** 「累」类词的常见误判：积累/拖累/连累/受累/劳累/带累/牵累。 */
const LEI_COMPOUND_PREFIX = new Set(['积', '拖', '连', '受', '劳', '带', '牵', '同']);

/** 词是否被前面的否定词否掉（「不难过了」里的「难过」）。 */
function isNegatedAt(text: string, word: string): boolean {
  const idx = text.indexOf(word);
  if (idx === -1) return false;
  const before = text.slice(Math.max(0, idx - 2), idx);
  return NEGATION_WORDS.some((n) => before.includes(n));
}

/**「积累了不少经验」里的「累了」不是情绪，要排除。 */
function isLeiCompound(text: string, word: string): boolean {
  if (!word.startsWith('累')) return false;
  const idx = text.indexOf(word);
  if (idx <= 0) return false;
  return LEI_COMPOUND_PREFIX.has(text[idx - 1]);
}

/** 强度加成：感叹号 / 重复字。 */
function bumpIntensity(text: string, base: 1 | 2 | 3): 1 | 2 | 3 {
  const exclaim = (text.match(/[！!]/g) ?? []).length;
  if (exclaim >= 2 && base < 3) return (base + 1) as 1 | 2 | 3;
  return base;
}

/**
 * 从一段用户文本里抽取情感事件（纯函数）。
 *
 * @param text 用户本轮消息
 * @param at   epoch 毫秒
 * @param target 这些话说的是谁（默认用户本人在说）
 */
export function extractEmotionEvents(text: string, at: number, target: EventTarget = 'user'): EmotionEvent[] {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return [];

  const events: EmotionEvent[] = [];
  const seen = new Set<EmotionEventType>();

  for (const rule of RULES) {
    if (events.length >= MAX_EVENTS_PER_MESSAGE) break;
    if (seen.has(rule.type)) continue;

    for (const word of rule.words) {
      if (!trimmed.includes(word)) continue;
      // 否定过滤：但 broken_promise 这类强规则不受否定影响
      if (!rule.strong && isNegatedAt(trimmed, word)) continue;
      if (isLeiCompound(trimmed, word)) continue;

      seen.add(rule.type);
      events.push({
        type: rule.type,
        intensity: bumpIntensity(trimmed, rule.intensity),
        // 用户夸/骂的是 AI；用户倾诉的是自己的事
        target: rule.target === 'user' ? target : rule.target,
        evidence: sentenceOf(trimmed, word),
        at,
        resolved: !isNegativeEvent(rule.type),
      });
      break;
    }
  }

  return neutralizeIrony(trimmed, events, at);
}

/** 反讽词：命中时「真厉害」这类字面表扬其实是阴阳。 */
const POSITIVE_TYPES: EmotionEventType[] = ['praise', 'thanks', 'share_joy', 'affection'];

/**
 * 反讽矫正：「呵呵，真厉害」「服了，你可真行」——字面是夸，实际是被阴阳了。
 * 这里不做复杂的语义分析，只做一件保守的事：把正向事件换成一个轻量 insult。
 * 真需要细判的留给每日任务的 Workers AI 复核。
 */
function neutralizeIrony(text: string, events: EmotionEvent[], at: number): EmotionEvent[] {
  const ironyWord = IRONY_HINTS.find((w) => text.includes(w));
  if (!ironyWord) return events;
  const hasPositive = events.some((e) => POSITIVE_TYPES.includes(e.type));
  if (!hasPositive) return events;
  const kept = events.filter((e) => !POSITIVE_TYPES.includes(e.type));
  kept.unshift({
    type: 'insult',
    intensity: 1,
    target: 'ai',
    evidence: sentenceOf(text, ironyWord),
    at,
    resolved: false,
  });
  return kept;
}

/** 事件 → 情绪向量增量（乘以强度权重）。 */
export function eventEmotionDelta(event: EmotionEvent): Partial<EmotionVector> {
  const w = event.intensity === 3 ? 1.5 : event.intensity === 2 ? 1 : 0.6;
  const scale = (n: number) => Math.round(n * w);
  switch (event.type) {
    case 'praise':
      return { valence: scale(12), shyness: scale(10), dominance: scale(4) };
    case 'thanks':
      return { valence: scale(8), attachment: scale(5) };
    case 'apology':
      // 道歉不直接走这个表（要带走「不清空、只减半」的特殊逻辑，见 applyEventsToVector）
      return { valence: scale(4) };
    case 'comfort_seek':
      return { attachment: scale(8), valence: scale(2) };
    case 'affection':
      return { shyness: scale(12), attachment: scale(10), valence: scale(10) };
    case 'tease':
      return { valence: scale(4), grievance: scale(2) };
    case 'command':
      return { dominance: -scale(4), grievance: scale(3) };
    case 'rejection':
      return { valence: -scale(8), dominance: -scale(6), grievance: scale(8) };
    case 'insult':
      return { valence: -scale(14), grievance: scale(16), dominance: -scale(10) };
    case 'broken_promise':
      return { grievance: scale(10), valence: -scale(6) };
    case 'share_joy':
      return { valence: scale(8) };
    case 'share_pain':
      return { valence: -scale(5), attachment: scale(6) };
    case 'deep_talk':
      return { attachment: scale(10), shyness: scale(3) };
    case 'ignored':
      return { attachment: -scale(6), grievance: scale(5) };
    default:
      return {};
  }
}

/**
 * 把一批事件叠加到情绪向量上。
 *
 * ★ 道歉是特例：**不清空委屈，只减半**。
 *   一句「对不起」就把账全销了，关系就没有张力了；
 *   真正的修复应当是「先松一点，还要看后续」——这也更符合真人。
 *   下限 10 的意思是：刚吵完不会立刻归零，要再哄一次或隔一天才慢慢淡。
 */
export function applyEventsToVector(
  vector: EmotionVector,
  events: EmotionEvent[],
  maxStep = EMOTION_MAX_STEP_PER_TURN,
): EmotionVector {
  let next = vector;
  for (const event of events) {
    if (event.type === 'apology') {
      const w = event.intensity === 3 ? 1.5 : event.intensity === 2 ? 1 : 0.6;
      const delta: Partial<EmotionVector> = { valence: Math.round(4 * w) };
      if (next.grievance > 0) {
        const target = Math.max(10, Math.round(next.grievance * (1 - 0.4 * w)));
        delta.grievance = target - next.grievance;
      }
      next = applyEmotionDelta(next, delta, maxStep);
      continue;
    }
    next = applyEmotionDelta(next, eventEmotionDelta(event), maxStep);
  }
  return next;
}

export interface FacetDelta {
  affection?: number;
  trust?: number;
  respect?: number;
  attraction?: number;
}

/**
 * 事件对关系 5 轴的增量（轮级微增量，天级结算）。
 *
 * 注意方向语义：
 * - 用户侮辱 AI → AI 对用户的「尊重」下降（会开始敷衍、怼回去）
 * - 用户爽约/撒谎 → 「信任」下降（开始保留、少说真话）
 * - 深夜深聊 / 表白 / 黏人 → 「心动」上升
 */
export function eventFacetDelta(event: EmotionEvent): FacetDelta {
  const w = event.intensity === 3 ? 3 : event.intensity === 2 ? 2 : 1;
  switch (event.type) {
    case 'praise':
      return { affection: 0.4 * w, respect: 0.1 * w };
    case 'thanks':
      return { affection: 0.3 * w, trust: 0.1 * w };
    case 'apology':
      return { trust: 0.2 * w, respect: 0.1 * w };
    case 'comfort_seek':
      return { affection: 0.3 * w, attraction: 0.2 * w };
    case 'affection':
      return { affection: 0.5 * w, attraction: 0.8 * w };
    case 'tease':
      return { affection: 0.2 * w, attraction: 0.1 * w };
    case 'command':
      return { respect: -0.3 * w };
    case 'rejection':
      return { affection: -0.4 * w, trust: -0.2 * w };
    case 'insult':
      return { affection: -0.8 * w, respect: -0.8 * w };
    case 'broken_promise':
      return { trust: -0.8 * w };
    case 'share_joy':
      return { affection: 0.2 * w };
    case 'share_pain':
      return { affection: 0.3 * w, trust: 0.3 * w, attraction: 0.2 * w };
    case 'deep_talk':
      return { trust: 0.6 * w, attraction: 0.4 * w };
    case 'ignored':
      return { affection: -0.3 * w, attraction: -0.2 * w };
    default:
      return {};
  }
}

/** 把一批事件的 5 轴增量加总。 */
export function sumFacetDelta(events: EmotionEvent[]): Required<FacetDelta> {
  const total = { affection: 0, trust: 0, respect: 0, attraction: 0 };
  for (const event of events) {
    const d = eventFacetDelta(event);
    total.affection += d.affection ?? 0;
    total.trust += d.trust ?? 0;
    total.respect += d.respect ?? 0;
    total.attraction += d.attraction ?? 0;
  }
  return total;
}

/** 未化解的负向事件（强度 ≥ min 且未超龄）。 */
export function unresolvedEvents(events: EmotionEvent[], now: number, maxAgeMs = 7 * 86400_000, min = 2): EmotionEvent[] {
  return events.filter(
    (e) => isNegativeEvent(e.type) && !e.resolved && e.intensity >= min && now - e.at <= maxAgeMs,
  );
}

/**
 * 和解：出现道歉时，把更早的负向事件标记为已化解。
 * 注意只化解「比道歉更早」的事件——之后新骂的还要重新哄。
 */
export function reconcileWithApology(events: EmotionEvent[], now: number): EmotionEvent[] {
  const apology = events
    .filter((e) => e.type === 'apology')
    .sort((a, b) => b.at - a.at)
    .find((e) => now - e.at <= 30 * 60_000);
  if (!apology) return events;
  return events.map((e) => {
    if (isNegativeEvent(e.type) && !e.resolved && e.at <= apology.at) {
      return { ...e, resolved: true };
    }
    return e;
  });
}

/** 词典可能判错的信号：否定 / 反讽 / 正负冲突。 */
export function needsAiEventReview(text: string, events: EmotionEvent[]): boolean {
  const t = (text ?? '').trim();
  if (!t) return false;
  if (IRONY_HINTS.some((w) => t.includes(w))) return true;
  const hasPositive = events.some((e) => ['praise', 'thanks', 'affection', 'share_joy'].includes(e.type));
  const hasNegative = events.some((e) => isNegativeEvent(e.type) || e.type === 'share_pain');
  if (hasPositive && hasNegative) return true;
  // 有否定词 + 至少一个事件 → 可能整体被否定
  if (events.length > 0 && NEGATION_WORDS.some((w) => t.includes(w))) return true;
  return false;
}

/** AI 复核的系统提示词：要求只输出事件列表。 */
const EVENT_VERIFY_SYSTEM = `你是情感分析器。阅读用户这句话，判断其中真实存在的情感事件。
只输出事件，用英文逗号分隔，每个格式为「类型:强度」，强度 1-3。没有就输出 none。
可用类型：praise(夸对方) thanks(感谢) apology(道歉) affection(表达喜欢/想念) insult(侮辱/贬低)
rejection(拒绝话题) broken_promise(对方爽约/失信) share_joy(分享开心) share_pain(倾诉难过)
deep_talk(交心/说心里话) tease(玩笑式损人) complaint(抱怨对方)
注意否定与反讽，以最终真实情绪为准。不要解释。`;

/** 事件标签 → 中文类型（AI 输出容错）。 */
export function parseAiEventLabels(raw: string, at: number): EmotionEvent[] {
  const text = (raw ?? '').trim().toLowerCase();
  if (!text || text.includes('none') || text.includes('无')) return [];
  const out: EmotionEvent[] = [];
  const parts = text.split(/[,，;；\s]+/).filter(Boolean);
  for (const part of parts) {
    const [rawType, rawIntensity] = part.split(/[:：]/);
    const type = normalizeLabel(rawType);
    if (!type) continue;
    const n = Number(rawIntensity);
    const intensity = (n === 3 ? 3 : n === 2 ? 2 : 1) as 1 | 2 | 3;
    out.push({
      type,
      intensity,
      target: type === 'share_joy' || type === 'share_pain' || type === 'deep_talk' ? 'user' : 'ai',
      evidence: '(AI 复核)',
      at,
      resolved: !isNegativeEvent(type),
    });
    if (out.length >= 3) break;
  }
  return out;
}

function normalizeLabel(raw: string): EmotionEventType | null {
  const t = (raw ?? '').trim();
  const map: Record<string, EmotionEventType> = {
    praise: 'praise',
    thanks: 'thanks',
    apology: 'apology',
    affection: 'affection',
    insult: 'insult',
    rejection: 'rejection',
    broken_promise: 'broken_promise',
    share_joy: 'share_joy',
    share_pain: 'share_pain',
    deep_talk: 'deep_talk',
    tease: 'tease',
    complaint: 'command',
    iguess: 'ignored',
  };
  return map[t] ?? null;
}

/**
 * 用 Workers AI 复核一条消息里的事件（只在每日任务里调用，不进聊天关键路径）。
 *
 * 失败时返回空数组，由调用方回退到词典结果——这条链路上 AI 永远是「补充」，
 * 不是「必须」；AI 挂了情感系统照样跑。
 */
export async function reviewEventsWithAI(env: Env, text: string, at: number): Promise<EmotionEvent[]> {
  const t = (text ?? '').trim();
  if (!t) return [];
  try {
    const res = await env.AI.run(env.DISTILL_MODEL, {
      messages: [
        { role: 'system', content: EVENT_VERIFY_SYSTEM },
        { role: 'user', content: t.slice(-500) },
      ],
      max_tokens: 24,
      temperature: 0.1,
    });
    const raw = (res as { response?: string }).response ?? '';
    return parseAiEventLabels(raw, at);
  } catch (e) {
    console.warn('[emotion-events] Workers AI 复核失败，回退词典结果：', e);
    return [];
  }
}
