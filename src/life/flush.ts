/**
 * 把压着的消息补发出去（P2 / §8.3）。
 *
 * 主路径是懒生成：App 到点来拉，现场生成。这里是兜底——
 * cron 每 5 分钟看一眼，到期的就生成一条回复落库，夜里攒的一并处理。
 *
 * 连发多条合成一轮回一次（§8.4），不是每条各回一次。
 */
import type { Env } from '../types';
import { streamChat } from '../chat';
import { lifeEnabled } from './gate';
import { logError } from '../error-log';

export interface FlushResult {
  flushed: number;
  skipped?: string;
}

export async function flushHeldMessages(env: Env, now = new Date()): Promise<FlushResult> {
  if (!(await lifeEnabled(env))) return { flushed: 0, skipped: 'disabled' };

  const rows = await env.DB.prepare(
    `SELECT id, content FROM messages
     WHERE role = 'user' AND reply_state = 'pending' AND hold_until_ms IS NOT NULL AND hold_until_ms <= ?
     ORDER BY id ASC LIMIT 10`,
  )
    .bind(now.getTime())
    .all<{ id: number; content: string }>()
    .catch(() => null);
  const pending = rows?.results ?? [];
  if (pending.length === 0) return { flushed: 0, skipped: 'empty' };

  // 先标 answered 再生成：生成慢，期间不该被下一次 cron 重复捞到
  for (const row of pending) {
    await env.DB.prepare("UPDATE messages SET reply_state = 'answered' WHERE id = ?")
      .bind(row.id)
      .run()
      .catch(() => {});
  }

  const merged = pending.map((r) => r.content).join('\n');
  try {
    // 复用最后一条消息的 id：不插新用户消息，回复直接挂在那条上
    const res = await streamChat(env, merged, now, undefined, 'mobile', 'life-flush', {
      reuseUserMessageId: pending[pending.length - 1].id,
    });
    await res.text(); // 消费完流，回复在 onFinish 里落库
  } catch (e) {
    logError('[life] 补发失败:', e);
    return { flushed: 0, skipped: 'error' };
  }
  return { flushed: pending.length };
}
