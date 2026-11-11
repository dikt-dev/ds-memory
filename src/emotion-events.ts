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
import { logError, logWarn } from './error-log';
import { logTrace } from './trace';
import { callLlmOnce } from './llm';

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
    // 有意不含「笨蛋/笨死了」：这类在情侣对话里基本是打情骂俏，归 tease
    words: ['你懂什么', '没用', '废物', '垃圾', '闭嘴', '滚', '蠢', '傻逼', '烦不烦', '你有病'],
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
    intensity: 3,
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
    intensity: 2,
    target: 'ai',
    words: ['哈哈哈', '笑死', '笨蛋', '笨死了', '傻子', '嫌弃你', '嫌弃', '小笨蛋'],
  },
  {
    type: 'command',
    intensity: 1,
    target: 'ai',
    // 去掉「马上」：它太常见了（马上吃饭/马上睡/马上给你点），一个月能刷出十几个假指令
    words: ['快去', '给我', '赶紧', '别废话', '你马上'],
  },
];

/**
 * 「给我」是中式命令里最大的误伤来源（2026-11-10）：
 * 「念给我听」「给我点杯奶茶」「怎么让小蓝安慰我啊」句句含"给我"，全都不是命令。
 * 真命令是硬的：祈使句，没有请求语、没有撒娇。
 */
const SOFT_REQUEST =
  /(吗|好吗|好不好|行不行|能不能|可不可以|呗|求你|求求|拜托|大人|帮我|听|安慰|想听|要不要|一起)/;

/** 这条消息算不算真的在使唤她。 */
export function isRealCommand(text: string): boolean {
  return !SOFT_REQUEST.test(text);
}

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

/**
 * 单字词的复合词排除表：前面的字一旦命中，就不是这个词的意思。
 *
 * 「滚」是重灾区：回滚、滚动、翻滚、滚轮。之前「# 记忆快照与回滚方案」
 * 被记成强度 3 的侮辱，一次 +24 委屈——她记的其实是你的技术文档。
 */
const COMPOUND_PREFIX: Record<string, Set<string>> = {
  滚: new Set(['回', '翻', '打', '电', '滚', '摇']),
  蠢: new Set(['愚']),
};

/** 命中复合词前缀时丢弃该词。 */
function isCompoundWord(text: string, word: string): boolean {
  const prefixes = COMPOUND_PREFIX[word];
  if (!prefixes) return false;
  let from = 0;
  for (;;) {
    const idx = text.indexOf(word, from);
    if (idx === -1) return true;
    if (idx > 0 && prefixes.has(text[idx - 1])) {
      from = idx + 1;
      continue;
    }
    return false;
  }
}

/**
 * 问句：他在问我，不是在陈述自己（2026-11-11）。
 *
 * 线上 33 条 share_pain 全部来自同一句「我最近在焦虑什么」——他在问我，
 * 被词典的「焦虑」记成他天天在诉苦，然后她天天心疼一个不存在的事。
 */
const QUESTION_TAIL = /(什么|啥|吗|么|呢|几|哪|谁|多少|怎么|如何|是不是|有没有|对不对)[\s。！!~～]*$/;

/** 问句里不成立的事件类型：这些词出现在问句里是「话题」不是「状态」。 */
const QUESTION_SILENT: EmotionEventType[] = ['share_pain', 'share_joy', 'praise', 'deep_talk'];

export function isQuestionText(text: string): boolean {
  const t = (text ?? '').trim();
  if (!t) return false;
  if (/[？?]/.test(t)) return true;
  // 只看最后一个分句：前面可能在说事，末尾才是提问
  const last = t.split(/[。！!；;\n]/).filter((s) => s.trim()).pop() ?? t;
  return QUESTION_TAIL.test(last);
}

/**
 * 「没用我也要抱」里的「没用」是在说自己没用，不是骂她（2026-11-11 线上误判）。
 * 判据：这个词后面紧跟第一人称/让步词，或前面两字里没有「你」。
 */
function isSelfDeprecating(text: string, word: string): boolean {
  if (word !== '没用') return false;
  const idx = text.indexOf(word);
  if (idx === -1) return false;
  const after = text.slice(idx + word.length, idx + word.length + 1);
  const before = text.slice(Math.max(0, idx - 2), idx);
  if (after && '我他它也都还就'.includes(after)) return true;
  return !/你|他妈/.test(before);
}

/**「积累了不少经验」里的「累了」不是情绪，要排除。 */
function isLeiCompound(text: string, word: string): boolean {
  if (!word.startsWith('累')) return false;
  const idx = text.indexOf(word);
  if (idx <= 0) return false;
  return LEI_COMPOUND_PREFIX.has(text[idx - 1]);
}

/** 加强词：让「很累」和「有点累」落到不同强度。 */
const STRONG_WORDS = ['很', '太', '特别', '超', '巨', '极其', '死了', '疯了', '爆'];
const WEAK_WORDS = ['有点', '稍微', '有一点点', '些许', '略'];

/** 强度调整：加强词 +1、削弱词 -1、连续感叹号 +1。 */
function bumpIntensity(text: string, base: 1 | 2 | 3): 1 | 2 | 3 {
  let b = base;
  const exclaim = (text.match(/[！!]/g) ?? []).length;
  if (exclaim >= 2) b += 1;
  if (STRONG_WORDS.some((w) => text.includes(w))) b += 1;
  if (WEAK_WORDS.some((w) => text.includes(w))) b -= 1;
  return Math.min(3, Math.max(1, b)) as 1 | 2 | 3;
}

/** 玩笑标记：有这些信号时，「蠢/笨/没用」多半是打情骂俏，不是真的被冒犯。 */
const PLAYFUL_HINTS = ['哈哈', '嘿嘿', '笑死', '开玩笑', '逗你', '别当真', '狗头', '233', 'hhh', '嘻嘻'];

/**
 * 玩笑降级：骂人词出现在明显的玩笑语境里 → 退成 tease(1)。
 *
 * 原来「你个笨蛋」「笨死了」按 insult 强度 3 记，一次就 +24 委屈；
 * 而增益的另一半（tease）根本不产生委屈。真实对话里被记仇的多半是这类玩笑。
 */
function softenPlayfulInsult(text: string, events: EmotionEvent[]): EmotionEvent[] {
  if (!PLAYFUL_HINTS.some((w) => text.includes(w))) return events;
  return events.map((e) =>
    e.type === 'insult' ? { ...e, type: 'tease' as const, intensity: 1 as const, resolved: true } : e,
  );
}

/**
 * 从一段用户文本里抽取情感事件（纯函数）。
 *
 * @param text 用户本轮消息
 * @param at   epoch 毫秒
 * @param target 这些话说的是谁（默认用户本人在说）
 */
/**
 * 引用块里的句子不是他说的（2026-11-11）。
 *
 * 实测事故：B 站那条 [BILI_META] 里的画面过程（视频字幕、弹幕、梗图配文）
 * 被当成他的原话喂进抽取——「0:24 我说好的」被记成 broken_promise 3、
 * 「大白龙表情无语」被记成 insult、「还是他找到更聪明的AI了」被记成 praise。
 * 结果她凭空背着 45 分委屈过了半天。
 */
const QUOTED_MEDIA_RE = /\[BILI_META\][\s\S]*?(?:\[\/BILI_META\]|$)/gi;

export function stripQuotedMedia(text: string): string {
  return (text ?? '')
    .replace(QUOTED_MEDIA_RE, ' ')
    .replace(/##\s*画面过程[\s\S]*$/, ' ');
}

export function extractEmotionEvents(text: string, at: number, target: EventTarget = 'user'): EmotionEvent[] {
  const trimmed = stripQuotedMedia(text).trim();
  if (!trimmed) return [];

  const events: EmotionEvent[] = [];
  const seen = new Set<EmotionEventType>();
  const question = isQuestionText(trimmed);

  for (const rule of RULES) {
    if (events.length >= MAX_EVENTS_PER_MESSAGE) break;
    if (seen.has(rule.type)) continue;
    if (question && QUESTION_SILENT.includes(rule.type)) continue;

    for (const word of rule.words) {
      if (!trimmed.includes(word)) continue;
      // 否定过滤：但 broken_promise 这类强规则不受否定影响
      if (!rule.strong && isNegatedAt(trimmed, word)) continue;
      if (isLeiCompound(trimmed, word)) continue;
      if (isCompoundWord(trimmed, word)) continue;
      if (isSelfDeprecating(trimmed, word)) continue;

      // 命令要过"这不是求她"这一关，否则委屈就会为一句撒娇买单
      if (rule.type === 'command' && !isRealCommand(trimmed)) continue;

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

  // 「被领导当众骂了一顿」这类：关键词表按连续子串匹配，中间隔字就漏。
  // 被动式 + 负面动词单独补一层，否则他真的受挫时她毫无反应。
  if (events.length < MAX_EVENTS_PER_MESSAGE && !seen.has('share_pain') && !question) {
    const passive = /被[^，。！？,.!?\s]{0,6}(骂|批|批评|怼|嘲|罚|投诉|扣钱|开除)/.exec(trimmed);
    if (passive) {
      seen.add('share_pain');
      events.push({
        type: 'share_pain',
        intensity: 2,
        target,
        evidence: sentenceOf(trimmed, passive[0]),
        at,
        resolved: true,
      });
    }
  }

  return neutralizeIrony(trimmed, softenPlayfulInsult(trimmed, events), at);
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
      return { valence: scale(12), shyness: scale(10), dominance: scale(4), arousal: scale(8) };
    case 'thanks':
      return { valence: scale(8), attachment: scale(5) };
    case 'apology':
      // 道歉不直接走这个表（要带走「不清空、只减半」的特殊逻辑，见 applyEventsToVector）
      return { valence: scale(4) };
    case 'comfort_seek':
      return { attachment: scale(8), valence: scale(2) };
    case 'affection':
      return { shyness: scale(12), attachment: scale(10), valence: scale(10), arousal: scale(12) };
    case 'tease':
      return { valence: scale(4), grievance: scale(2), arousal: scale(6) };
    case 'command':
      return { dominance: -scale(4), grievance: scale(3) };
    case 'rejection':
      return { valence: -scale(8), dominance: -scale(6), grievance: scale(8), arousal: scale(8) };
    case 'insult':
      return { valence: -scale(14), grievance: scale(16), dominance: -scale(10), arousal: scale(10) };
    case 'broken_promise':
      return { grievance: scale(10), valence: -scale(6) };
    case 'share_joy':
      return { valence: scale(8), arousal: scale(10) };
    case 'share_pain':
      // ★ 他的遭遇不是她的事件（2026-11-06 修）：
      //   以前这里连她的愉悦度一起扣，结果「他被领导骂」→ 她 valence 掉到 −10 以下
      //   → 脾气判「不想配合」→ 他更难受，形成正反馈。
      //   共情的正确表达是「更贴近」（依恋），不是「我自己也难过」。
      return { attachment: scale(6) };
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
  /** 熟悉度：只涨不跌（互动量），以前没接、导致关系阶段永远卡在 Lv1 */
  intimacy?: number;
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
      return { affection: 0.4 * w, respect: 0.1 * w, intimacy: 0.3 * w };
    case 'thanks':
      return { affection: 0.3 * w, trust: 0.1 * w, intimacy: 0.3 * w };
    case 'apology':
      return { trust: 0.2 * w, respect: 0.1 * w };
    case 'comfort_seek':
      return { affection: 0.3 * w, attraction: 0.2 * w, intimacy: 0.6 * w };
    case 'affection':
      return { affection: 0.5 * w, attraction: 0.8 * w, intimacy: 0.8 * w };
    case 'tease':
      return { affection: 0.2 * w, attraction: 0.1 * w, intimacy: 0.5 * w };
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
      return { affection: 0.3 * w, trust: 0.3 * w, attraction: 0.2 * w, intimacy: 0.6 * w };
    case 'deep_talk':
      return { trust: 0.6 * w, attraction: 0.4 * w, intimacy: 1.5 * w };
    case 'ignored':
      return { affection: -0.3 * w, attraction: -0.2 * w };
    default:
      return {};
  }
}

/** 把一批事件的 5 轴增量加总。 */
export function sumFacetDelta(events: EmotionEvent[]): Required<FacetDelta> {
  const total = { affection: 0, trust: 0, respect: 0, attraction: 0, intimacy: 0 };
  for (const event of events) {
    const d = eventFacetDelta(event);
    total.affection += d.affection ?? 0;
    total.trust += d.trust ?? 0;
    total.respect += d.respect ?? 0;
    total.attraction += d.attraction ?? 0;
    total.intimacy += d.intimacy ?? 0;
  }
  return total;
}

/**
 * 轻微事件（命令、调侃）只挂一天（2026-11-10）。
 *
 * 原来一律挂 7 天，于是「给我重启一下」这种一句话的小摩擦能让提示词连着一周
 * 念叨「心里还记着这件事还没过去」。真正该留 7 天的是被拒绝、被骂、爽约。
 */
const MINOR_GRIEVANCE_TTL_MS = 24 * 3600_000;

/** 未化解的负向事件（强度 ≥ min 且未超龄）。 */
export function unresolvedEvents(events: EmotionEvent[], now: number, maxAgeMs = 7 * 86400_000, min = 2): EmotionEvent[] {
  return events.filter((e) => {
    if (!isNegativeEvent(e.type) || e.resolved || e.intensity < min) return false;
    const ttl =
      e.type === 'command' || e.type === 'tease'
        ? Math.min(MINOR_GRIEVANCE_TTL_MS, maxAgeMs)
        : maxAgeMs;
    return now - e.at <= ttl;
  });
}

/**
 * 和解：出现道歉时，把更早的负向事件标记为已化解。
 * 注意只化解「比道歉更早」的事件——之后新骂的还要重新哄。
 */
export function reconcileWithApology(events: EmotionEvent[], now: number): EmotionEvent[] {
  const apology = events
    .filter((e) => e.type === 'apology')
    .sort((a, b) => b.at - a.at)
    // 30 分钟太短：真人吵架常常隔半天才道歉。这里放宽到 6 小时，
    // 仍然只化解「道歉之前」的事件，道歉后新骂的还要重新哄。
    .find((e) => now - e.at <= 6 * 3600_000);
  if (!apology) return events;
  return events.map((e) => {
    if (isNegativeEvent(e.type) && !e.resolved && e.at <= apology.at) {
      return { ...e, resolved: true };
    }
    return e;
  });
}

/**
 * 「他正在难受」：最近有没有倾诉类事件。
 *
 * 给状态卡用——他倒苦水时她该做的是接住、追问，而不是把自己的脾气调冷。
 */
export function recentPainEvent(
  events: EmotionEvent[] | undefined,
  now: number,
  windowMs = 30 * 60_000,
): EmotionEvent | null {
  if (!events || events.length === 0) return null;
  const fresh = events.filter(
    (e) =>
      e.target === 'user' &&
      (e.type === 'share_pain' || e.type === 'comfort_seek') &&
      now - e.at <= windowMs,
  );
  return fresh.length > 0 ? fresh[fresh.length - 1] : null;
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
const EVENT_VERIFY_SYSTEM = `你在判断一段聊天里「他」最后这句话真实存在的情感事件。

只判最后一行「他：」。前面标着「你：」的是她自己之前说的话，不是他说的，不要从里面抽事件。
引号里的、以时间轴开头的（0:24 / 50秒）、[资料]/[BILI_META] 开头的内容都是引用别处的材料，不算他说的话。
问句（问我、确认、反问）和请求（让我做事）不是情绪事件。
反讽按反讽算：「你可真行」「真厉害啊」是挖苦，不是夸奖。

只输出一行：类型:强度，多个用英文逗号分隔，强度 1-3；没有就输出 none。
可选类型：praise thanks apology affection insult rejection broken_promise share_joy
share_pain deep_talk tease complaint

不要解释。`;

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
    // complaint 是抱怨/撒娇，不是命令：原来记成 command 会平白加委屈（2026-11-10）
    complaint: 'comfort_seek',
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
export async function reviewEventsWithAI(
  env: Env,
  text: string,
  at: number,
  /** 最近两三轮，带「他：」「你：」标签；没有就只判这一句 */
  context = '',
): Promise<EmotionEvent[]> {
  const t = stripQuotedMedia(text).trim();
  if (!t) return [];
  const userContent = context.trim()
    ? context.trim() + '\n他：' + t.slice(-500)
    : t.slice(-500);

  // ① 主办方模型（LLM_JUDGE_MODEL，默认跟提炼一样的千问大模型）：
  //    3B 的 llama 读不懂反讽、问句和转述，判出来的结果和词典差不多。
  try {
    const raw = await judgeWithLlm(env, userContent);
    if (raw) return parseAiEventLabels(raw, at);
  } catch (e) {
    logWarn('[emotion-events] 主办方复核失败，退回 Workers AI：', e);
  }

  // ② 兜底：Workers AI 小模型（原来的路径，判不准但不会让链路断）
  try {
    const res = await env.AI.run(env.DISTILL_MODEL, {
      messages: [
        { role: 'system', content: EVENT_VERIFY_SYSTEM },
        { role: 'user', content: userContent },
      ],
      max_tokens: 24,
      temperature: 0.1,
    });
    const raw = (res as { response?: string }).response ?? '';
    return parseAiEventLabels(raw, at);
  } catch (e) {
    logWarn('[emotion-events] Workers AI 复核失败，回退词典结果：', e);
    return [];
  }
}

/** 调主办方模型做一次判定；没有任何 key 时返回空串，让调用方走兜底。 */
async function judgeWithLlm(env: Env, userContent: string): Promise<string> {
  const raw = await callLlmOnce(env as never, 'judge', EVENT_VERIFY_SYSTEM, userContent, { maxTokens: 40 });
  if (raw) logTrace('emotion.judge', { msg: raw.slice(0, 40) });
  return raw;
}