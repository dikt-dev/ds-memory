/**
 * 校验器（§5.5）。不过就换种子重抽，最多 3 次。
 *
 * 每条校验都对应一种「看起来不像人」的失败：
 *   睡着还在回消息 / 一整天都在忙 / 一天五段碎活动 / 活动压在睡觉上。
 */
import { BY_ID } from './pool';
import { MAX_ACTIVITIES, MAX_EXTRAS, MAX_MEALS, SLEEP_START, WAKE_AT, type DayPlan } from './planner';

export interface ValidationIssue {
  rule: string;
  detail: string;
}

const DAY = 1440;

/** 把跨午夜的时间折回 0~1440，方便和「01:00–08:00 睡觉」比较。 */
function norm(minute: number): number {
  return ((minute % DAY) + DAY) % DAY;
}

/**
 * 醒着的时间轴是 08:00 → 次日 01:00（480 → 1500）。
 *
 * 早先按「折回 0~1440 后判断端点」写，会漏掉两种：
 * 活动整个压在睡眠里，以及刚好停在 02:00 被判成越界。直接比时间轴最稳。
 */
function outOfAwake(start: number, end: number, wakeAt = WAKE_AT): boolean {
  return start < wakeAt || end > SLEEP_START;
}

export function validateDay(plan: DayPlan): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const acts = [...plan.activities].sort((a, b) => a.start - b.start);
  const wakeAt = plan.wakeAt ?? WAKE_AT;

  // ① 01:00–08:00 必须是 sleep
  for (const a of acts) {
    if (outOfAwake(a.start, a.end, wakeAt)) {
      issues.push({
        rule: 'sleep-window',
        detail: `${BY_ID.get(a.unitId)?.name ?? a.unitId} 压在 01:00–08:00 的睡眠上`,
      });
    }
  }

  // ② 活动不重叠
  for (let i = 1; i < acts.length; i += 1) {
    if (acts[i].start < acts[i - 1].end) {
      issues.push({
        rule: 'overlap',
        detail: `${acts[i - 1].unitId} 与 ${acts[i].unitId} 时间重叠`,
      });
    }
  }

  // ③ 单日活动 ≤ MAX_ACTIVITIES 段（三餐不算活动名额：吃饭不是「又去做了一件事」）
  // 写日记和吃饭一样是日常，不算「又去做了一件事」
  const nonMeal = acts.filter((a) => BY_ID.get(a.unitId)?.kind !== 'meal' && a.unitId !== 'diary_write').length;
  if (nonMeal > MAX_ACTIVITIES) {
    issues.push({ rule: 'too-many', detail: `一天 ${nonMeal} 段活动，超过 ${MAX_ACTIVITIES} 段上限` });
  }
  if (acts.length > MAX_ACTIVITIES + MAX_MEALS + MAX_EXTRAS + 1) {
    issues.push({ rule: 'too-many', detail: `一天 ${acts.length} 段（含三餐和加餐），超过上限` });
  }

  // ④ 可回消息时长 ≥ 清醒时长 60%
  // 清醒 = 08:00 → 次日 01:00，共 17 小时；睡眠 01:00–08:00 是 7 小时
  const awake = SLEEP_START - wakeAt;
  const blocked = acts
    .filter((a) => BY_ID.get(a.unitId)?.interruptible === false)
    .reduce((sum, a) => sum + (a.end - a.start), 0);
  const reachable = awake - blocked;
  if (reachable < awake * 0.6) {
    issues.push({
      rule: 'reachable',
      detail: `可回消息 ${Math.round(reachable)} 分钟 < 清醒 ${awake} 的 60%`,
    });
  }

  // ⑤ 不在池子里的单元（生成 bug 的兜底）
  for (const a of acts) {
    if (!BY_ID.has(a.unitId)) {
      issues.push({ rule: 'unknown-unit', detail: `池子里没有 ${a.unitId}` });
    }
  }

  return issues;
}