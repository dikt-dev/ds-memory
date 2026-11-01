/**
 * 消息闸门（P2 / §8）。
 *
 * 她忙或在睡的时候，消息照收、不立刻回：先落库，到点再由 cron 或 App 拉。
 *
 * 三条硬规则：
 *   1. 默认关。`life:enabled` 不是 '1' 就永远不拦——线上行为保证可回退。
 *   2. 睡觉时不看 reply_chance，一律等到 09:00（她真的睡）。
 *   3. 忙的时候按那段活动的 reply_chance 抽，抽中才「忙里偷闲」回一句。
 */
import type { Env } from '../types';
import { lifeNow } from './jobs';
import { makeRng } from './seed';

export interface GateDecision {
  hold: boolean;
  /** 预计什么时候回，给 App 显示「她 21:30 左右看」 */
  until?: string;
  /** 写进日志/排查用 */
  reason?: string;
  state?: string;
}

/**
 * 开关是否打开。
 *
 * 两种写法都支持：环境变量 AI_LIFE（off 强制关），以及 KV 里的 life:enabled。
 * 默认关——P2 上线要显式打开，出事改一个 KV 键就能退。
 */
export async function lifeEnabled(env: Env): Promise<boolean> {
  if (env.AI_LIFE === 'off') return false;
  const flag = await env.KV.get('life:enabled').catch(() => null);
  return flag === '1';
}

function hhmm(minute: number): string {
  const m = minute % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/**
 * 这条消息现在要不要压着。
 *
 * 注意：返回 hold=true 时调用方**仍然要落库**，只是跳过生成。
 */
export async function gateDecision(env: Env, now = new Date()): Promise<GateDecision> {
  if (!(await lifeEnabled(env))) return { hold: false, reason: 'disabled' };

  const status = await lifeNow(env, now);
  if (status.status === 'sleeping') {
    return { hold: true, until: '09:00', reason: 'asleep', state: 'sleeping' };
  }
  if (status.status === 'busy' && status.current) {
    const chance = status.current.reply_chance ?? 0.3;
    const roll = makeRng(`${status.dateKey}|${status.current.start_min}|${Math.floor(now.getTime() / 60000)}`);
    if (!roll.chance(chance)) {
      // 忙里偷闲：真的在忙（不可打断）且这段活动本身让她心情好时，
      // 仍然留着 12% 的机会回一句。全是「不理你」会显得像拉黑。
      const sneaking = !status.current.interruptible && (status.current.mood_delta ?? 0) > 0;
      const sneak = makeRng(`${status.dateKey}|${status.current.start_min}|sneak|${Math.floor(now.getTime() / 60000)}`);
      if (sneaking && sneak.chance(0.12)) {
        return { hold: false, reason: 'busy-but-sneaking', state: 'busy' };
      }
      return {
        hold: true,
        until: hhmm(status.current.end_min),
        reason: 'busy',
        state: 'busy',
      };
    }
    return { hold: false, reason: 'busy-but-lucky', state: 'busy' };
  }
  return { hold: false, reason: 'free', state: status.status };
}

/** 把一条用户消息标成待回复。 */
export async function markHeld(
  env: Env,
  messageId: number,
  holdUntilMs: number,
): Promise<void> {
  await env.DB.prepare(
    "UPDATE messages SET reply_state = 'pending', hold_until_ms = ? WHERE id = ?",
  )
    .bind(holdUntilMs, messageId)
    .run()
    .catch(() => {});
}

/** 把「HH:MM」换算成下一次出现的毫秒时间（跨天则算明天）。 */
export function untilMs(now: Date, hhmmText: string): number {
  const [h, m] = hhmmText.split(':').map(Number);
  const target = new Date(now);
  target.setHours(h, m, 0, 0);
  if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
  return target.getTime();
}
