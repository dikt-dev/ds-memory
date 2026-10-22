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

/** 月份键的下一个月 'YYYY-MM'。 */
export function nextMonthKey(mk: string): string {
  const [y, m] = mk.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m, 1));
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
