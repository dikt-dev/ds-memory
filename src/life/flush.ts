/**
 * 把压着的消息补发出去（P2 / §8.3）。
 *
 * 主路径是懒生成：App 到点来拉，现场生成。这里是兜底——
 * cron 每 5 分钟看一眼，到期的就生成一条回复落库，夜里攒的一并处理。
 *
 * 连发多条合成一轮回一次（§8.4），不是每条各回一次。
 *
 * 租约（lease）：认领时把 reply_state 改成 'processing'、hold_until_ms 推后 10 分钟。
 * 生成成功才置 'answered'；失败退回 'pending' 并延后 10 分钟重试。
 * 这样进程被杀/模型报错都不会把消息吞掉——上一版是「先标 answered 再生成」，
 * 生成一失败，这条消息就永远停在 answered，再也不会被补发。
 */
import type { Env } from '../types';
import { streamChat } from '../chat';
import { lifeEnabled } from './gate';
import { lifeNow } from './jobs';
import { logError } from '../error-log';

/** 认领后的租约时长：超过这个时间还停在 processing，说明那一轮挂了，回收重试。 */
const LEASE_MS = 10 * 60 * 1000;

/** 等待时长说成人话：47 分钟 / 3 小时 20 分钟。 */
export function formatWait(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} 分钟`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} 小时` : `${h} 小时 ${m} 分钟`;
}

/**
 * 压着的那批消息，回之前先交代：他等了多久、她当时在忙什么。
 * 纯函数，便于单测；措辞只给事实和一句许可，不给台词。
 */
export function heldWaitNote(waitedMs: number, where: string | null): string {
  const waited = formatWait(waitedMs);
  const what = where ? `你当时${where}` : '你当时没顾上看手机';
  return (
    `（他这几条是 ${waited}前发来的，${what}，现在才看到。` +
    '先随口带一句，别装作刚才发生，也不要报时间点，然后再说正事。' +
    '（别每次都用同一个说法——"才看见""刚忙完"用两次就腻了，换个方式讲。）'
  );
}

export interface FlushResult {
  flushed: number;
  skipped?: string;
}

export async function flushHeldMessages(env: Env, now = new Date()): Promise<FlushResult> {
  if (!(await lifeEnabled(env))) return { flushed: 0, skipped: 'disabled' };

  const nowMs = now.getTime();

  // 回收过期租约：上一轮认领后没走完（cron 进程被杀、模型报错没回滚到）
  await env.DB.prepare(
    `UPDATE messages SET reply_state = 'pending'
     WHERE role = 'user' AND reply_state = 'processing'
       AND hold_until_ms IS NOT NULL AND hold_until_ms <= ?`,
  )
    .bind(nowMs)
    .run()
    .catch(() => {});

  const rows = await env.DB.prepare(
    `SELECT id, content, created_ms FROM messages
     WHERE role = 'user' AND reply_state = 'pending' AND hold_until_ms IS NOT NULL AND hold_until_ms <= ?
     ORDER BY id ASC LIMIT 10`,
  )
    .bind(nowMs)
    .all<{ id: number; content: string; created_ms: number | null }>()
    .catch(() => null);
  const pending = rows?.results ?? [];
  if (pending.length === 0) return { flushed: 0, skipped: 'empty' };

  // 逐条认领：只有把 pending 改成 processing 成功的那一方才生成，
  // 避免 cron 和 night-wake 同时捞到同一批、各回一次。
  const claimed: Array<{ id: number; content: string; created_ms: number | null }> = [];
  for (const row of pending) {
    const res = await env.DB.prepare(
      `UPDATE messages SET reply_state = 'processing', hold_until_ms = ?
       WHERE id = ? AND reply_state = 'pending'`,
    )
      .bind(nowMs + LEASE_MS, row.id)
      .run()
      .catch(() => null);
    if ((res?.meta?.changes ?? 0) === 1) claimed.push(row);
  }
  if (claimed.length === 0) return { flushed: 0, skipped: 'claimed-elsewhere' };

  // 每一批都告诉她：他等了多久、她当时在干什么。
  // 不写清楚，她会把两小时前的消息当成刚刚发生的（实测：早上八点回「没睡，在揉面团呢」）。
  const oldest = claimed[0].created_ms ?? nowMs;
  const atArrival = await lifeNow(env, new Date(oldest)).catch(() => null);
  const where = !atArrival
    ? null
    : atArrival.status === 'sleeping'
      ? '在睡觉'
      : atArrival.status === 'busy' && atArrival.current
        ? `在${atArrival.current.title}`
        : null;
  const merged = [
    claimed.map((r) => r.content).join('\n'),
    heldWaitNote(nowMs - oldest, where),
  ].join('\n\n');
  try {
    // 复用最后一条消息的 id：不插新用户消息，回复直接挂在那条上
    const res = await streamChat(env, merged, now, undefined, 'mobile', 'life-flush', {
      reuseUserMessageId: claimed[claimed.length - 1].id,
    });
    await res.text(); // 消费完流，回复在 onFinish 里落库
  } catch (e) {
    logError('[life] 补发失败:', e);
    // 生成失败：退回 pending，10 分钟后再试；消息不能丢
    for (const row of claimed) {
      await env.DB.prepare(
        "UPDATE messages SET reply_state = 'pending', hold_until_ms = ? WHERE id = ? AND reply_state = 'processing'",
      )
        .bind(nowMs + LEASE_MS, row.id)
        .run()
        .catch(() => {});
    }
    return { flushed: 0, skipped: 'error' };
  }

  for (const row of claimed) {
    await env.DB.prepare("UPDATE messages SET reply_state = 'answered' WHERE id = ?")
      .bind(row.id)
      .run()
      .catch(() => {});
  }
  return { flushed: claimed.length };
}
