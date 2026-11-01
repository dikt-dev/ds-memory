/**
 * 夜里醒来（P3-2）。
 *
 * 她 02:00 睡下、09:00 醒，中间的消息一律压到早上——但一年三百六十五天都这样，
 * 就变成一台准时的机器了。真实的人是偶尔凌晨会醒一下的：
 * 醒了，看见手机上有几条没回的消息，回一句又睡过去。
 *
 * 三条约束：
 *   1. 每周 1–2 次（2/7），按日期哈希定，同一天结果一致。
 *   2. 只在**确实有待回消息**时醒——没有就不醒，不然就是凭空发消息。
 *   3. 醒的时刻固定用 04:00 那条 cron：此刻往回翻，压着的消息最多。
 *      给不了「随机的两点半」，就别假装随机；宁可少一样东西，也别做假的。
 */
import type { Env } from '../types';
import { lifeEnabled } from './gate';
import { beijingDateKey } from './state';
import { makeRng, hashSeed } from './seed';
import { flushHeldMessages } from './flush';

export interface NightWakeResult {
  woke: boolean;
  replied: number;
  reason?: string;
}

/** 这一晚她会不会醒（约每 5 天一次，且不會连着两晚）。纯函数，方便测。 */
export function wakesTonight(dateKey: string): boolean {
  const rng = makeRng(`${dateKey}|night-wake`);
  if (!rng.chance(2 / 7)) return false;
  // 连着两晚醒＝「夜夜失眠」，观感很差：昨晚醒过，今晚就睡踏实
  const prev = new Date(Date.parse(dateKey + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10);
  return !makeRng(`${prev}|night-wake`).chance(2 / 7);
}

/**
 * 04:00 cron 里调用：今晚醒了就把压着的消息回掉。
 *
 * 只把**已经压着**的消息放出来，不主动发新消息——她醒来是因为看见有消息，
 * 不是因为「到点了该发一条」。
 */
export async function maybeNightWake(
  env: Env,
  now = new Date(),
  opts: { force?: boolean } = {},
): Promise<NightWakeResult> {
  if (!opts.force && !(await lifeEnabled(env))) return { woke: false, replied: 0, reason: 'disabled' };

  const dateKey = beijingDateKey(now);
  if (!opts.force && !wakesTonight(dateKey)) return { woke: false, replied: 0, reason: 'slept-through' };

  const held = await env.DB.prepare(
    "SELECT id FROM messages WHERE reply_state = 'pending' AND hold_until_ms > ?",
  )
    .bind(now.getTime())
    .all<{ id: number }>()
    .catch(() => null);
  const ids = (held?.results ?? []).map((r) => r.id);
  if (ids.length === 0) return { woke: false, replied: 0, reason: 'nothing-waiting' };

  const stamp = now.getTime();
  await env.DB.prepare(
    `UPDATE messages SET hold_until_ms = ? WHERE id IN (${ids.map(() => '?').join(',')})`,
  )
    .bind(stamp, ...ids)
    .run()
    .catch(() => {});

  await flushHeldMessages(env, now).catch(() => {});
  return { woke: true, replied: ids.length };
}

/** 记一笔：这一晚醒过（诊断用，避免「到底有没有醒」靠猜）。 */
export function nightWakeSeed(dateKey: string): number {
  return hashSeed(`${dateKey}|night-wake`);
}
