/**
 * 当日滚动摘要（阶段 4）：
 * - 触发：今天累计消息 ≥20 条，或距上次摘要 ≥2 小时且存在未总结的新消息；
 * - 增量：只提炼 up_to_id 之后的消息，由 Workers AI 生成 ≈100 字摘要；
 * - 存储：KV summary:YYYY-MM-DD = {text, updated_at, up_to_id}（TTL 36h；每日归档时删除）；
 * - 使用：聊天上下文组装时读入，与长期记忆（memory.md）、短期（最近 10 轮）并列。
 */
import type { Env } from './types';
import { latestMessage } from './db';
import { distillText } from './distill';
import { addLlmCost } from './llm-cost';

export const SUMMARY_TRIGGER_COUNT = 20; // 今天累计消息条数阈值（约 10 轮）
export const SUMMARY_TRIGGER_INTERVAL_MS = 2 * 60 * 60 * 1000; // 距上次摘要时间阈值
export const SUMMARY_KV_TTL_SECONDS = 36 * 60 * 60;
const LOCK_TTL_SECONDS = 120;

export interface DaySummary {
  text: string;
  updated_at: string;
  up_to_id: number;
}

export const summaryKey = (dateKey: string) => `summary:${dateKey}`;
const lockKey = (dateKey: string) => `summary:lock:${dateKey}`;

/** 触发判断（纯函数，可单测）：条数达标，或距上次摘要超过 2 小时。 */
export function shouldSummarize(total: number, prev: DaySummary | null, nowMs: number): boolean {
  if (total >= SUMMARY_TRIGGER_COUNT) return true;
  if (prev) {
    const age = nowMs - new Date(prev.updated_at).getTime();
    return Number.isFinite(age) && age >= SUMMARY_TRIGGER_INTERVAL_MS;
  }
  return false;
}

export async function getDaySummaryRaw(env: Env, dateKey: string): Promise<DaySummary | null> {
  try {
    const raw = await env.KV.get(summaryKey(dateKey));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as DaySummary;
    if (typeof parsed.text === 'string' && typeof parsed.up_to_id === 'number') return parsed;
    return null;
  } catch {
    return null;
  }
}

/** 当天摘要文本（无则 null）。 */
export async function getTodaySummary(env: Env, dateKey: string): Promise<string | null> {
  const s = await getDaySummaryRaw(env, dateKey);
  return s && s.text.trim() ? s.text.trim() : null;
}

/** 供聊天请求异步调用：判断触发条件并生成/更新摘要（锁 + up_to_id 增量，可安全重复调用）。
 *
 * ★ 顺序很重要：先做便宜判断（读最新消息 + 当日计数），确认要生成才加锁。
 *   之前的写法是「先查锁→写锁→…→删锁」，于是每条消息都白写两次 KV。
 */
export async function maybeSummarizeToday(env: Env, dateKey: string): Promise<void> {
  try {
    const latest = await latestMessage(env);
    if (!latest) return;
    const prev = await getDaySummaryRaw(env, dateKey);
    if (prev && latest.id <= prev.up_to_id) return; // 没有新消息

    const countRow = await env.DB.prepare('SELECT COUNT(*) AS c FROM messages WHERE date_key = ?')
      .bind(dateKey)
      .first<{ c: number }>();
    const total = countRow?.c ?? 0;
    if (total === 0) return;
    if (!shouldSummarize(total, prev, Date.now())) return;

    // 便宜判断通过后才加锁
    const lock = lockKey(dateKey);
    if (await env.KV.get(lock).catch(() => null)) return;
    await env.KV.put(lock, '1', { expirationTtl: LOCK_TTL_SECONDS }).catch(() => {});

    try {
      // 二次确认：并发窗口里可能已经有人生成过
      const fresh = await getDaySummaryRaw(env, dateKey);
      if (fresh && fresh.up_to_id >= latest.id) return;

      const rows = fresh
        ? await env.DB.prepare(
            'SELECT role, content FROM messages WHERE date_key = ? AND id > ? ORDER BY id ASC',
          )
            .bind(dateKey, fresh.up_to_id)
            .all<{ role: string; content: string }>()
        : await env.DB.prepare('SELECT role, content FROM messages WHERE date_key = ? ORDER BY id ASC')
            .bind(dateKey)
            .all<{ role: string; content: string }>();
      const msgs = rows.results ?? [];
      if (msgs.length === 0) return;

      const conversation = msgs.map((m) => `${m.role === 'user' ? '用户' : '助手'}：${m.content}`).join('\n');
      const input = `${fresh?.text ? `此前今日摘要：${fresh.text}\n\n` : ''}${conversation}`;
      const text = await summarizeToday(env, input, dateKey);
      if (!text) return;

      await env.KV.put(
        summaryKey(dateKey),
        JSON.stringify({ text, updated_at: new Date().toISOString(), up_to_id: latest.id } satisfies DaySummary),
        { expirationTtl: SUMMARY_KV_TTL_SECONDS },
      );
    } finally {
      await env.KV.delete(lock).catch(() => {});
    }
  } catch (e) {
    console.error('[summary] maybeSummarizeToday failed:', e);
  }
}

const SUMMARY_SYSTEM =
  '你是对话摘要助手。把用户今天的对话提炼成约 100 字的"今日摘要"，突出用户今天提到的事实、偏好、情绪与进行中的事项。输出简洁的中文纯文本，不要列表、标题或解释。';

/** 生成今日摘要：DeepSeek flash 档优先（成本），失败自动回退 Workers AI。 */
async function summarizeToday(env: Env, input: string, dateKey: string): Promise<string> {
  const result = await distillText(
    env,
    SUMMARY_SYSTEM,
    input.slice(0, 20000),
    512,
    env.SUMMARY_DEEPSEEK_MODEL || env.DEEPSEEK_MODEL,
  );
  console.log(`[summary] backend=${result.backend} cost=${result.cost.toFixed(5)}`);
  // 摘要费用也计入当天（此前只打日志，页面统计看不到）
  await addLlmCost(env, dateKey, result.cost);
  return result.text.slice(0, 180); // 防模型超长，保持约 100 字目标
}
