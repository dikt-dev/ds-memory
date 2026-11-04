/**
 * 当日滚动摘要（阶段 4）：
 * - 首次：今天累计消息 ≥20 条触发；
 * - 之后：距上次摘要新增 ≥10 条，或距上次 ≥1 小时才再次生成（避免第 20 条后每条消息都调一次模型）；
 * - 增量：只提炼 up_to_id 之后的消息，由 DeepSeek flash（失败回退 Workers AI）生成 ≈100 字摘要；
 * - 存储：D1 runtime_state key=`summary:YYYY-MM-DD` = {text, updated_at, up_to_id, total}（TTL 36h；每日归档时删除）；
 * - 使用：memo:24h 不存在时作为中期记忆兜底注入。
 */
import type { Env } from './types';
import { latestMessage } from './db';
import { distillText } from './distill';
import { addLlmCost } from './llm-cost';
import { acquireRuntimeLock, getRuntimeState, putRuntimeState, releaseRuntimeLock } from './runtime-store';
import { logTrace } from './trace';
import { logError, logWarn } from './error-log';

const logInfo = (msg: string): void => logTrace('summary', { msg });

/** 首次生成摘要的消息条数阈值（约 10 轮）。 */
export const SUMMARY_TRIGGER_COUNT = 20;
/** 首次之后，新增消息达到这个数才再生成。 */
export const SUMMARY_TRIGGER_DELTA = 10;
/** 首次之后的最小重算间隔（1 小时）。 */
export const SUMMARY_TRIGGER_INTERVAL_MS = 60 * 60 * 1000;
export const SUMMARY_KV_TTL_SECONDS = 36 * 60 * 60;
/** 单次送给摘要模型的最大字符数（保留最新的部分）。 */
export const SUMMARY_INPUT_MAX_CHARS = 20000;
/** 单次最多保留的当天新增对话字符数。 */
export const SUMMARY_CONVERSATION_MAX_CHARS = 18000;
const LOCK_TTL_SECONDS = 120;

export interface DaySummary {
  text: string;
  updated_at: string;
  up_to_id: number;
  /** 生成这份摘要时，当天 messages 的总条数（用于增量触发判断）。 */
  total?: number;
}

export const summaryKey = (dateKey: string) => `summary:${dateKey}`;
const lockKey = (dateKey: string) => `summary:lock:${dateKey}`;

/**
 * 触发判断（纯函数，可单测）：
 * - 没有历史摘要：累计 ≥20 条才首次生成；
 * - 有历史摘要：新增 ≥10 条，或距上次 ≥1 小时。
 */
export function shouldSummarize(total: number, prev: DaySummary | null, nowMs: number): boolean {
  if (!prev) return total >= SUMMARY_TRIGGER_COUNT;
  if (total <= 0) return false;
  const newMessages = total - (prev.total ?? 0);
  if (newMessages >= SUMMARY_TRIGGER_DELTA) return true;
  const age = nowMs - new Date(prev.updated_at).getTime();
  return Number.isFinite(age) && age >= SUMMARY_TRIGGER_INTERVAL_MS;
}

/** 构造摘要输入：旧摘要放最前，新增对话只保留最新的部分（避免丢最新消息）。 */
export function buildSummaryInput(prevText: string | null, conversation: string): string {
  const head = prevText?.trim() ? `此前今日摘要：${prevText.trim()}\n\n` : '';
  const tail =
    conversation.length > SUMMARY_CONVERSATION_MAX_CHARS
      ? conversation.slice(-SUMMARY_CONVERSATION_MAX_CHARS)
      : conversation;
  return `${head}${tail}`;
}

export async function getDaySummaryRaw(env: Env, dateKey: string): Promise<DaySummary | null> {
  try {
    const raw = await getRuntimeState(env, summaryKey(dateKey));
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

    // 便宜判断通过后才加锁；D1 原子 UPSERT，无 D1 时回退 KV。
    const lock = lockKey(dateKey);
    if (!(await acquireRuntimeLock(env, lock, LOCK_TTL_SECONDS))) return;

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
      const input = buildSummaryInput(fresh?.text ?? null, conversation);
      const text = await summarizeToday(env, input, dateKey);
      if (!text) return;

      await putRuntimeState(
        env,
        summaryKey(dateKey),
        JSON.stringify({
          text,
          updated_at: new Date().toISOString(),
          up_to_id: latest.id,
          total,
        } satisfies DaySummary),
        SUMMARY_KV_TTL_SECONDS,
      );
    } finally {
      await releaseRuntimeLock(env, lock);
    }
  } catch (e) {
    logError('[summary] maybeSummarizeToday failed:', e);
  }
}

const SUMMARY_SYSTEM =
  '你是对话摘要助手。把用户今天的对话提炼成约 100 字的"今日摘要"，突出用户今天提到的事实、偏好、情绪与进行中的事。输出简洁的中文纯文本，不要列表、标题或解释。';

/** 生成今日摘要：DeepSeek flash 档优先（成本），失败自动回退 Workers AI。 */
async function summarizeToday(env: Env, input: string, dateKey: string): Promise<string> {
  const result = await distillText(
    env,
    SUMMARY_SYSTEM,
    // ★ 保留最新的部分：之前的写法是 slice(0, 20000)，长对话会把最后 10k 字丢掉
    input.slice(-SUMMARY_INPUT_MAX_CHARS),
    512,
    env.SUMMARY_DEEPSEEK_MODEL || env.DEEPSEEK_MODEL,
  );
  logInfo(`[summary] backend=${result.backend} cost=${result.cost.toFixed(5)}`);
  // 摘要费用也计入当天（此前只打日志，页面统计看不到）
  await addLlmCost(env, dateKey, result.cost);
  return result.text.slice(0, 180); // 防模型超长，保持约 100 字目标
}
