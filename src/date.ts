/**
 * 时间工具：全系统统一使用北京时间（Asia/Shanghai, UTC+8）。
 * 所有落库 / 归档日期键均为北京时间的 YYYY-MM-DD。
 */
const BEIJING_TZ = 'Asia/Shanghai';

const WEEKDAY_NAMES = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'] as const;

/**
 * ★ Intl.DateTimeFormat 的构造在 Workers 里不算便宜，而它每轮聊天都要用。
 *   这里全部提到模块级只建一次（Worker isolate 复用期间一直有效）。
 */
const DATE_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: BEIJING_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const ISO_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: BEIJING_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

const HOUR_FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: BEIJING_TZ,
  hour: '2-digit',
  hour12: false,
});

const MONTH_FMT = new Intl.DateTimeFormat('en-GB', { timeZone: BEIJING_TZ, month: '2-digit' });

/** 北京时间下的 YYYY-MM-DD 日期键。 */
export function dateKeyInBeijing(d: Date = new Date()): string {
  const parts = DATE_FMT.formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** 北京时间下的 ISO8601 字符串（显式 +08:00 偏移）。 */
export function isoInBeijing(d: Date = new Date()): string {
  const parts = ISO_FMT.formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}+08:00`;
}

/** 北京时间的小时（0-23）。注意某些 ICU 版本 24 点会返回 "24"，已取模归一。 */
export function beijingHour(d: Date = new Date()): number {
  return Number(HOUR_FMT.format(d)) % 24;
}

/** 北京时间的月份（1-12）。 */
export function beijingMonth(d: Date = new Date()): number {
  return Number(MONTH_FMT.format(d));
}

const CN_DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

function cnNumber(n: number): string {
  if (n < 10) return CN_DIGITS[n];
  const tens = Math.floor(n / 10);
  const ones = n % 10;
  return (tens === 1 ? '十' : CN_DIGITS[tens] + '十') + (ones ? CN_DIGITS[ones] : '');
}

/**
 * 北京时间的口语读法，**按半小时取整**：晚上九点 / 晚上九点半 / 晚上十点。
 *
 * 不给精确到分：精确读法会让回复变成报时（"现在是九点十一分"），而且模型
 * 一旦开始算分钟就容易算歪。半小时的粒度足够她说清"现在几点了"，也不会
 * 因为 21:10 和 21:55 都算成"快十点"。
 *
 * 取整规则：<15 分 → 本小时整点；15–44 分 → 半点；≥45 分 → 进位到下一小时。
 */
export function spokenTime(d: Date = new Date()): string {
  const parts = ISO_FMT.formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  let hour = Number(get('hour')) % 24;
  const minute = Number(get('minute'));
  let half = false;
  if (minute >= 45) {
    hour = (hour + 1) % 24;
  } else if (minute >= 15) {
    half = true;
  }
  const period =
    hour < 5 ? '凌晨' : hour < 8 ? '早上' : hour < 12 ? '上午' : hour === 12 ? '中午' : hour < 18 ? '下午' : '晚上';
  // 中文说"两点"，不说"二点"；整点用"十二点"不用"零点"（零点只在 0 点用）
  const h = hour % 12 === 0 ? 12 : hour % 12;
  const hourText = hour === 0 ? '零点' : h === 2 ? '两点' : `${cnNumber(h)}点`;
  return `${period}${hourText}${half ? '半' : ''}`;
}

/** 日期键对应的星期名（日期键本身即北京时间日历日，直接用 UTC 解析）。 */
export function weekdayName(dateKey: string): string {
  const [y, m, day] = dateKey.split('-').map(Number);
  return WEEKDAY_NAMES[new Date(Date.UTC(y, m - 1, day)).getUTCDay()];
}

/** dateKey + n 天（可负）。 */
export function addDays(dateKey: string, n: number): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${mm}-${dd}`;
}

/** 前一天（每日归档任务用：04:00 归档的是刚结束的自然日）。 */
export function previousDateKey(dateKey: string): string {
  return addDays(dateKey, -1);
}

/** 日期键 → 月份键 'YYYY-MM'。 */
export function monthKey(dateKey: string): string {
  return dateKey.slice(0, 7);
}

/** 月份键的上一个月 'YYYY-MM'。 */
export function previousMonthKey(mk: string): string {
  const [y, m] = mk.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 2, 1));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** 月份键对应的天数（如 2026-02 → 28）。 */
export function daysInMonth(mk: string): number {
  const [y, m] = mk.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** dateKey 减 n 个月（日超出目标月天数时钳制到月末）。 */
export function subtractMonths(dateKey: string, n: number): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 - n, 1));
  const ty = target.getUTCFullYear();
  const tm = target.getUTCMonth();
  const lastDay = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  const dt = new Date(Date.UTC(ty, tm, Math.min(d, lastDay)));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}
