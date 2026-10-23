/**
 * 关系状态的持久化辅助（累计聊天天数等）。
 *
 * ★ 为什么需要单独存：亲密度的天数硬上限依赖「累计有效聊天天数」。
 *   这个数原本直接从 D1 `messages` 统计，但月度归档会删除 3 个月前的消息，
 *   导致统计值随使用时间**倒退**——上限从 1000 跌回 480，
 *   于是聊得越久反而越涨不动。历史累计必须存到不受 D1 清理影响的地方。
 *
 * 存储位置：KV（永久，无 TTL）+ R2 兜底镜像。
 * 语义：记录「已经出现过消息的日期集合」的规模，只增不减。
 */
import type { Env } from './types';

/** 历史累计的有效聊天天数（与 D1 现有行数取最大值）。 */
const ACTIVE_DAYS_KEY = 'relation:active_days';

export interface ActiveDaysState {
  /** 历史累计有效聊天天数（只增不减） */
  days: number;
  /** 最近一次确认过的日期（YYYY-MM-DD），避免同一天重复 +1 */
  lastDate: string | null;
}

/** 读取历史累计天数状态。 */
export async function getActiveDaysState(env: Env): Promise<ActiveDaysState> {
  try {
    const raw = await env.KV.get(ACTIVE_DAYS_KEY);
    if (!raw) return { days: 0, lastDate: null };
    const parsed = JSON.parse(raw) as Partial<ActiveDaysState>;
    const days = Number(parsed.days);
    const lastDate = typeof parsed.lastDate === 'string' ? parsed.lastDate : null;
    if (!Number.isFinite(days) || days < 0) return { days: 0, lastDate };
    return { days: Math.floor(days), lastDate };
  } catch {
    return { days: 0, lastDate: null };
  }
}

/** 写入历史累计天数状态。 */
export async function setActiveDaysState(env: Env, state: ActiveDaysState): Promise<void> {
  const payload: ActiveDaysState = {
    days: Math.max(0, Math.floor(state.days)),
    lastDate: state.lastDate,
  };
  // 永久保存（不带 expirationTtl）：这份数据一旦丢失就会让亲密度上限倒退
  await env.KV.put(ACTIVE_DAYS_KEY, JSON.stringify(payload)).catch((e) => {
    console.error('[relation-store] 写入累计天数失败:', e);
  });
}

/**
 * 计算「有效聊天天数」的最终取值。
 *
 * 规则：历史累计与 D1 现值取较大者，并把新出现的日期计入历史。
 * 这样 D1 清理不会让数字倒退，而历史丢失时也能靠 D1 自愈。
 *
 * @param stored 已持久化的历史状态
 * @param d1Days D1 当前统计到的不同日期数
 * @param forDate 本次归档的目标日期（YYYY-MM-DD）
 */
export function mergeActiveDays(
  stored: ActiveDaysState,
  d1Days: number,
  forDate: string,
): { state: ActiveDaysState; effective: number; advanced: boolean } {
  const d1 = Math.max(0, Math.floor(d1Days));
  // 历史值只增不减；D1 可能因清理变小，所以取 max
  let days = Math.max(stored.days, d1);

  // 归档一个「历史从未计入过」的新日期时 +1。
  // 用 lastDate 做单调性保护：只接受比上次更晚的日期，避免补跑旧日期时重复计数。
  let advanced = false;
  let lastDate = stored.lastDate;
  if (!lastDate || forDate > lastDate) {
    days += 1;
    lastDate = forDate;
    advanced = true;
  }

  return {
    state: { days, lastDate },
    effective: Math.max(days, 1),
    advanced,
  };
}
