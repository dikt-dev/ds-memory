/**
 * 话题索引（L_topic）：每天 3~8 个话题标题，按日期存。
 *
 * 为什么单独一层：长期记忆只记「事实」（住哪、做什么），记不住「哪天聊了什么」。
 * 有了这层，她说得出「前天你发的那个视频」，而不只是笼统的「我们聊过」。
 *
 * 生成时机：每日归档时顺手做（从当天摘要或原对话里压标题），成本可忽略。
 * 注入：最近 3 天的标题，约 30~60 字；更早的按需检索。
 */
import type { Env } from './types';
import { addDays, dateKeyInBeijing } from './date';
import { distillText } from './distill';
import { getRuntimeState, putRuntimeState } from './runtime-store';
import { getDaySummaryRaw } from './summary';
import { logError } from './error-log';

export const TOPIC_TTL_SECONDS = 120 * 24 * 3600;
export const TOPIC_INJECT_DAYS = 3;

export const topicKey = (dateKey: string): string => `topics:${dateKey}`;

const TOPIC_SYSTEM = [
  '你在给「某一天聊过什么」做索引。',
  '输出 3~8 个话题标题，每行一个，不加编号、不加标点、不加解释。',
  '每个标题 2~8 个字，要具体、能被回指：视频名/外号/地点/约定/事件，不要写成「聊了两句」「日常闲聊」。',
  '按当天重要程度排，最可能被再提起的放第一。',
].join('\n');

export async function getDayTopics(env: Env, dateKey: string): Promise<string[]> {
  const raw = await getRuntimeState(env, topicKey(dateKey)).catch(() => null);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as { topics?: unknown };
    return Array.isArray(parsed.topics)
      ? parsed.topics.filter((t): t is string => typeof t === 'string' && t.trim().length > 0).slice(0, 8)
      : [];
  } catch {
    return [];
  }
}

/** 生成某天的话题索引（已有就跳过；没有素材就返回空）。 */
export async function ensureDayTopics(env: Env, dateKey: string): Promise<string[]> {
  const existing = await getDayTopics(env, dateKey);
  if (existing.length > 0) return existing;

  let source = '';
  const summary = await getDaySummaryRaw(env, dateKey).catch(() => null);
  if (summary?.text?.trim()) {
    source = summary.text.trim();
  } else {
    const rows = await env.DB.prepare(
      'SELECT role, content FROM messages WHERE date_key = ? ORDER BY id ASC LIMIT 120',
    )
      .bind(dateKey)
      .all<{ role: string; content: string }>()
      .catch(() => null);
    const msgs = rows?.results ?? [];
    if (msgs.length === 0) return [];
    source = msgs
      .map((m) => `${m.role === 'user' ? '他' : '你'}：${m.content.slice(0, 120)}`)
      .join('\n')
      .slice(-6000);
  }
  if (!source) return [];

  try {
    const r = await distillText(env, TOPIC_SYSTEM, source, 200, { kind: 'summary' });
    const topics = r.text
      .split('\n')
      .map((l) => l.replace(/^[-•\d.、\s]+/, '').trim())
      .filter((l) => l.length >= 2 && l.length <= 12)
      .slice(0, 8);
    if (topics.length === 0) return [];
    await putRuntimeState(env, topicKey(dateKey), JSON.stringify({ topics, at: new Date().toISOString() }), TOPIC_TTL_SECONDS);
    return topics;
  } catch (e) {
    logError('[topics] generate failed:', e);
    return [];
  }
}

/**
 * 最近 N 天的话题块（进提示词）；没有内容返回空串。
 *
 * ★ 缓存成单个 KV key：原来是每天读一次 KV（3 天 = 3 次往返），
 *   实测这段占了请求准备时间的绝大部分（每次 ~80ms × 3）。
 *   现在 10 分钟内只读 1 次。
 */
export const TOPIC_BLOCK_KEY = 'topics:recent';
const TOPIC_BLOCK_TTL_MS = 10 * 60 * 1000;

export async function recentTopicsBlock(
  env: Env,
  now: Date,
  days = TOPIC_INJECT_DAYS,
  opts: { allowDb?: boolean } = {},
): Promise<string> {
  const cached = await env.KV.get(TOPIC_BLOCK_KEY, 'json').catch(() => null) as
    | { at?: number; text?: string }
    | null;
  if (cached?.text != null && typeof cached.at === 'number' && now.getTime() - cached.at < TOPIC_BLOCK_TTL_MS) {
    return cached.text;
  }
  // 请求路径上读不到缓存就返回空：D1 跨区一次 200ms，宁可这一轮少三行话题，
  // 也不要把回复拖慢（cron 会很快把缓存填上）
  if (!opts.allowDb) return '';
  const today = dateKeyInBeijing(now);
  const lines: string[] = [];
  for (let back = 1; back <= days; back += 1) {
    const day = addDays(today, -back);
    const topics = await getDayTopics(env, day);
    if (topics.length === 0) continue;
    const label = back === 1 ? '昨天' : back === 2 ? '前天' : `${back} 天前`;
    lines.push(`- ${label}（${day.slice(5)}）：${topics.join('、')}`);
  }
  const text = lines.join('\n');
  await env.KV.put(TOPIC_BLOCK_KEY, JSON.stringify({ at: now.getTime(), text }), {
    expirationTtl: 3600,
  }).catch(() => undefined);
  return text;
}
