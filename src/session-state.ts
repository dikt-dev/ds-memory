/**
 * 小忆「活人感」—— 会话级情绪残留（阶段 2 的补全）。
 *
 * 解决的核心问题：记忆里的心情值是「天级」漂移的，但对话是「轮级」的。
 * 用户刚和它开开心心聊完一件事，下一轮它不该"重置"回平静。
 *
 * 机制：每轮从最近的用户/助手消息里推断一份"即时情绪"，乘以一个残留系数，
 * 叠加到下一次的状态卡上；随时间自然衰减。存在 KV（会话级，非长期记忆）。
 *
 * 与 memory.md 的心情值（长期）+ 环境漂移（时段/天气）三者的关系：
 *   长期心情（基线） + 环境漂移（时段） + 情绪残留（最近几轮） = 本轮 effectiveMood
 */

import type { Env } from './types';

/** 会话情绪残留的 KV 键（只存"情绪标签 + 时间戳"，轻量）。 */
const SESSION_MOOD_KEY = 'session:mood';

/** 残留的衰减：每次读取时按这个速率向 0 回落。
 *
 * ★ 取值依据：文档要求「约 12 分钟指数衰减」。
 *   exp(-0.25 × 12) ≈ 0.050，即 12 分钟后只剩 5%，可视为基本消散。
 *   （原值 0.08 对应 12 分钟后仍保留 38%，比文档描述慢三倍，已修正）
 *   半衰期 = ln2 / 0.25 ≈ 2.8 分钟。
 */
export const DECAY_PER_MINUTE = 0.25;

/** 把「距上次多少分钟」算出残留保留系数（可单测）。 */
export function decayFactor(elapsedMinutes: number): number {
  return Math.exp(-DECAY_PER_MINUTE * Math.max(0, elapsedMinutes));
}

/** 各情绪标签对应的残留偏移（叠加到心情值上）。 */
const MOOD_OFFSET: Record<string, number> = {
  happy: 40,   // 开心会持续一会儿
  low: -30,    // 低落会持续一会儿
  tired: -20,  // 疲惫同理
  busy: -10,
  neutral: 0,
};

export interface SessionMood {
  /** 残留的心情偏移（-100~+100） */
  offset: number;
  /** 标签，用于状态卡描述 */
  label: string;
  /** 最后更新 epoch 毫秒 */
  at: number;
}

/** 判断文本里某个词是否被否定（如"不难过了"里的"难过"）。 */
function isNegated(text: string, word: string): boolean {
  const idx = text.indexOf(word);
  if (idx === -1) return false;
  // 看词前面 2 个字符内是否有否定词
  const before = text.slice(Math.max(0, idx - 2), idx);
  return /(不|没|别|不再)/.test(before);
}

/**
 * 由最近的对话文本推断一份即时情绪标签（带否定过滤 + 情绪冲突优先级）。
 *
 * 规则：
 * - 先排除被否定的词（"我不难过了" ≠ 低落）
 * - 负面情绪优先于正面：过程很烦但结果搞定 → 仍判"烦"，而非"开心"
 *   （真人的情绪残留更常停留在"负面"上，好结果不会立刻抹掉过程的不快）
 */
export function inferTag(userText: string, assistantText: string): string {
  const text = `${userText}\n${assistantText}`;

  const matchAny = (words: string[]): boolean =>
    words.some((w) => text.includes(w) && !isNegated(text, w));

  // ① 负面优先（低落 > 疲惫 > 忙碌）
  if (matchAny(['难过', '伤心', '想哭', '崩溃', '焦虑', '烦', '郁闷', 'emo', '不开心', '委屈'])) return 'low';
  if (matchAny(['累死', '好累', '困', '熬夜', '通宵', '没睡', '疲惫'])) return 'tired';
  if (matchAny(['在忙', '忙死', '赶工', 'ddl', '开会', '没空'])) return 'busy';

  // ② 正面（强词，避免"不错"误判）
  if (matchAny(['太好了', '哈哈', '嘿嘿', '搞定', '成功', '赢了'])) return 'happy';

  return 'neutral';
}

/** 读取当前残留（带时间衰减）。 */
export async function getSessionMood(env: Env, now: number): Promise<SessionMood> {
  try {
    const raw = await env.KV.get(SESSION_MOOD_KEY);
    if (!raw) return { offset: 0, label: 'neutral', at: now };
    const parsed = JSON.parse(raw) as SessionMood;
    const elapsedMin = (now - parsed.at) / 60000;
    const decay = decayFactor(elapsedMin); // 指数衰减
    const offset = Math.round(parsed.offset * decay);
    return offset === 0 ? { offset: 0, label: 'neutral', at: now } : { offset, label: parsed.label, at: parsed.at };
  } catch {
    return { offset: 0, label: 'neutral', at: now };
  }
}

/**
 * 合并情绪偏移（纯函数，可单测）：新旧情绪如何合成。
 * - 中性（next=0）：旧情绪原样保留（只靠时间自然衰减，不被中性消息冲淡）
 * - 有情绪：新情绪占主导 70%，旧残留保留 30%
 */
export function mergeMoodOffset(
  prev: { offset: number; label: string },
  next: number,
  tag: string,
): { offset: number; label: string } {
  if (next === 0) {
    return { offset: prev.offset, label: prev.label };
  }
  const merged = Math.max(-100, Math.min(100, Math.round(next * 0.7 + prev.offset * 0.3)));
  return { offset: merged, label: tag };
}

/** 在用户新消息进来后，更新情绪残留（先读旧值，叠加上新的）。 */
export async function updateSessionMood(env: Env, now: number, tag: string): Promise<void> {
  const prev = await getSessionMood(env, now);
  const next = MOOD_OFFSET[tag] ?? 0;
  const { offset, label } = mergeMoodOffset(prev, next, tag);
  const value: SessionMood = { offset, label, at: now };
  await env.KV.put(SESSION_MOOD_KEY, JSON.stringify(value), { expirationTtl: 2 * 3600 }).catch(() => {});
}

/** 把残留描述成状态卡里的一句话。 */
export function sessionMoodNote(m: SessionMood): string {
  if (m.offset === 0 || m.label === 'neutral') return '';
  if (m.label === 'happy') return `刚才聊得挺开心的，这股轻快劲儿还没散（残留 +${m.offset}）`;
  if (m.label === 'low') return `刚才聊到有点低落，情绪还没完全缓过来（残留 ${m.offset}）`;
  if (m.label === 'tired') return `刚才透着疲惫，自己也跟着有点蔫（残留 ${m.offset}）`;
  if (m.label === 'busy') return `刚才对方挺忙的，自己跟着收敛了点（残留 ${m.offset}）`;
  return '';
}