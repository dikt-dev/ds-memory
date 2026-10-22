/**
 * 情绪识别的 AI 复核（Workers AI，免费额度内）。
 *
 * 设计原则：**关键词优先，AI 只做歧义复核**。
 *
 * 为什么不全部交给 AI：
 * - 关键词匹配零成本、零延迟、可单测，80% 的情况已经够准
 * - 每次主动消息决策都调 AI 会拖慢 cron，也浪费免费额度
 *
 * 什么时候才调 AI（歧义场景）：
 * - 命中否定词："我不难过"、"今天不忙了"
 * - 命中转折词："虽然累但是开心"、"忙死了但搞定了"
 * - 正负信号冲突：既有负面词又有正面词
 * - 反讽/无语："哈哈哈这也太离谱了"
 *
 * 成本控制：
 * - 结果按文本哈希缓存 6 小时（同一段对话不重复调用）
 * - 只在 intensity > 0 时才考虑复核（完全中性没必要求助 AI）
 */

import type { Env } from './types';
import { analyzeMood, type MoodLabel, type MoodResult } from './mood';

/** 歧义缓存键前缀。 */
const MOOD_AI_CACHE_PREFIX = 'mood:ai:';
const CACHE_TTL_SECONDS = 6 * 60 * 60;

/** 否定词：出现时词典结果大概率是反的。 */
const NEGATION_WORDS = [
  '不', '没', '没有', '别', '无', '非', '未',
];

/** 转折词：前后情绪可能相反。 */
const TRANSITION_WORDS = [
  '但是', '但', '不过', '然而', '可是', '虽然', '尽管', '却', '反而',
];

/** 反讽/无语信号：词典容易误判为开心。 */
const IRONY_HINTS = [
  '离谱', '无语', '服了', '真的会谢', '呵呵', '牛逼', '绝了', '不愧是',
];

/**
 * 判断是否需要 AI 复核（纯函数，可单测）。
 *
 * 只在"词典可能判错"的情况下返回 true，避免无谓调用。
 */
export function needsAiVerification(text: string, keywordMood: MoodResult): boolean {
  if (!text || !text.trim()) return false;
  // 完全中性且无信号：没必要问 AI
  if (keywordMood.mood === 'neutral' && keywordMood.signals.length === 0) return false;

  const hasNegation = NEGATION_WORDS.some((w) => text.includes(w));
  const hasTransition = TRANSITION_WORDS.some((w) => text.includes(w));
  const hasIrony = IRONY_HINTS.some((w) => text.includes(w));

  // 反讽信号：必定复核（词典几乎肯定判错）
  if (hasIrony) return true;

  // 否定 + 有情绪信号：复核（"我不难过"）
  if (hasNegation && keywordMood.signals.length > 0) return true;

  // 转折 + 有情绪信号：复核（"虽然累但是开心"）
  if (hasTransition && keywordMood.signals.length >= 2) return true;

  // 正负信号同时出现：复核
  const hasPositive = keywordMood.signals.some((s) =>
    ['太好了', '哈哈', '嘿嘿', '爽', '棒', '赞', '爱了', '成功', '搞定', '通过了',
     '赢了', '舒服', '满足', '兴奋', '超开心', '开心', '高兴', '不错', '喜欢', '期待'].includes(s),
  );
  const hasNegative = keywordMood.signals.some((s) =>
    ['难过', '伤心', '想哭', '哭', '崩溃', '绝望', '孤独', '寂寞', '焦虑', '压力大',
     '烦', '烦躁', '郁闷', '压抑', '失落', '沮丧', '不开心', '委屈', '累死', 'emo',
     '好累', '累', '困', '熬夜', '通宵', '没睡', '失眠', '疲惫', '撑不住', '加班',
     '忙', '赶工', 'ddl', '截止', '开会', '没空'].includes(s),
  );
  if (hasPositive && hasNegative) return true;

  return false;
}

/**
 * 组合入口：关键词分析 → 判断是否需要 AI 复核 → 复核 → 合并。
 *
 * 调用方只需把这一个函数替换掉原来的 analyzeMood 即可，
 * 无歧义时行为与关键词版完全一致（无额外请求）。
 */
export async function analyzeMoodSmart(env: Env, text: string): Promise<MoodResult> {
  const keyword = analyzeMood(text);
  if (!needsAiVerification(text, keyword)) {
    return keyword;
  }
  const aiLabel = await verifyMoodWithAI(env, text, keyword);
  if (!aiLabel) return keyword;
  return mergeMood(keyword, aiLabel);
}

/** 简单字符串哈希（用于缓存键，不需要密码学强度）。 */
function quickHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
}

/** AI 复核的提示词：要求只输出一个词。 */
const VERIFY_SYSTEM = `你是一个情绪分类器。判断用户这段话当前的情绪状态。
只输出一个词，不要任何解释：
- low（低落/难过/焦虑/孤独）
- tired（疲惫/困/熬夜）
- busy（忙碌/没时间/赶工）
- happy（开心/兴奋/满足）
- neutral（平静/普通）

注意：如果句子里有否定（如"不难过了"）或转折（如"累但是开心"），要以**最终真实情绪**为准。`;

/**
 * 调用 Workers AI 复核情绪。
 *
 * 失败时返回 null，由调用方回退到关键词结果。
 */
export async function verifyMoodWithAI(
  env: Env,
  text: string,
  keywordMood: MoodResult,
): Promise<MoodLabel | null> {
  void keywordMood; // 保留参数：将来可能要「关键词 + AI」两段式，目前只用 AI 标签
  const cacheKey = `${MOOD_AI_CACHE_PREFIX}${quickHash(text)}`;
  try {
    const cached = await env.KV.get(cacheKey);
    if (cached) {
      const label = cached.trim() as MoodLabel;
      if (isValidLabel(label)) return label;
    }
  } catch {
    // KV 读失败不影响主流程
  }

  try {
    const res = await env.AI.run(env.DISTILL_MODEL, {
      messages: [
        { role: 'system', content: VERIFY_SYSTEM },
        { role: 'user', content: text.slice(-800) },
      ],
      max_tokens: 10,
      temperature: 0.1,
    });
    const raw = ((res as { response?: string }).response ?? '').trim().toLowerCase();
    const label = extractLabel(raw);
    if (!label) return null;

    await env.KV.put(cacheKey, label, { expirationTtl: CACHE_TTL_SECONDS }).catch(() => {});
    return label;
  } catch (e) {
    console.warn('[mood-ai] Workers AI 复核失败，回退关键词结果：', e);
    return null;
  }
}

function isValidLabel(s: string): boolean {
  return ['low', 'tired', 'busy', 'happy', 'neutral'].includes(s);
}

/** 从小模型输出里提取标签（容错：可能带解释或多行）。 */
export function extractLabel(raw: string): MoodLabel | null {
  if (!raw) return null;
  const lower = raw.toLowerCase();
  for (const label of ['low', 'tired', 'busy', 'happy', 'neutral'] as const) {
    if (lower.includes(label)) return label;
  }
  // 中文兜底
  if (/低落|难过|焦虑|孤独|伤心/.test(raw)) return 'low';
  if (/疲惫|累|困|熬夜/.test(raw)) return 'tired';
  if (/忙|没时间|赶/.test(raw)) return 'busy';
  if (/开心|兴奋|满足|高兴/.test(raw)) return 'happy';
  if (/平静|普通|中性/.test(raw)) return 'neutral';
  return null;
}

/**
 * 把 AI 复核结果合并进关键词结果。
 *
 * 规则：
 * - AI 与词典一致 → 增强强度（更确信）
 * - AI 与词典不一致 → 采信 AI，但降低强度（保守）
 */
export function mergeMood(keyword: MoodResult, aiLabel: MoodLabel): MoodResult {
  if (aiLabel === keyword.mood) {
    return {
      ...keyword,
      intensity: Math.min(1, keyword.intensity * 1.2),
      signals: [...keyword.signals, `ai:${aiLabel}`],
    };
  }
  // AI 纠正了词典：保守处理，强度打折
  const suggestContact = computeSuggestContact(aiLabel, keyword.intensity * 0.8);
  return {
    mood: aiLabel,
    valence: labelToValence(aiLabel),
    intensity: Math.min(1, Math.max(keyword.intensity * 0.8, 0.3)),
    signals: [...keyword.signals, `ai-corrected:${aiLabel}`],
    suggestContact,
  };
}

function labelToValence(label: MoodLabel): number {
  switch (label) {
    case 'happy': return 0.6;
    case 'low': return -0.7;
    case 'tired': return -0.4;
    case 'busy': return -0.2;
    default: return 0;
  }
}

function computeSuggestContact(label: MoodLabel, intensity: number): boolean {
  if (label === 'low') return true;      // 低落时更需要陪伴
  if (label === 'busy') return false;    // 忙时别打扰
  if (label === 'tired' && intensity >= 0.5) return false;
  return true;
}
