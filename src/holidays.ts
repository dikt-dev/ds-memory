/**
 * 中国节假日判断（内置国务院年度调休表 + 周末兜底）。
 *
 * 数据来源：国办发明电〔2025〕7 号《国务院办公厅关于2026年部分节假日安排的通知》
 * https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm
 *
 * 年度更新流程（见 README）：
 *   每年 11–12 月国务院发布次年安排后，新增 HOLIDAYS_<次年> 表；
 *   未收录年份自动退回"仅周末算休息日"。
 */
import { addDays, weekdayName } from './date';

export type HolidayKind = 'off' | 'workday'; // off=法定放假日；workday=调休上班日

export interface HolidayDef {
  date: string; // YYYY-MM-DD
  name: string; // 节日名
  kind: HolidayKind;
}

function range(from: string, to: string, name: string, kind: HolidayKind): HolidayDef[] {
  const out: HolidayDef[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push({ date: d, name, kind });
  return out;
}

export const HOLIDAYS_2026: HolidayDef[] = [
  // 元旦：1月1日（周四）至3日（周六），1月4日（周日）上班
  ...range('2026-01-01', '2026-01-03', '元旦', 'off'),
  { date: '2026-01-04', name: '元旦', kind: 'workday' },
  // 春节：2月15日（周日）至23日（周一）共9天，2月14日、2月28日（周六）上班
  ...range('2026-02-15', '2026-02-23', '春节', 'off'),
  { date: '2026-02-14', name: '春节', kind: 'workday' },
  { date: '2026-02-28', name: '春节', kind: 'workday' },
  // 清明节：4月4日（周六）至6日（周一），不调休
  ...range('2026-04-04', '2026-04-06', '清明节', 'off'),
  // 劳动节：5月1日（周五）至5日（周二），5月9日（周六）上班
  ...range('2026-05-01', '2026-05-05', '劳动节', 'off'),
  { date: '2026-05-09', name: '劳动节', kind: 'workday' },
  // 端午节：6月19日（周五）至21日（周日），不调休
  ...range('2026-06-19', '2026-06-21', '端午节', 'off'),
  // 中秋节：9月25日（周五）至27日（周日），不调休
  ...range('2026-09-25', '2026-09-27', '中秋节', 'off'),
  // 国庆节：10月1日（周四）至7日（周三），9月20日（周日）、10月10日（周六）上班
  ...range('2026-10-01', '2026-10-07', '国庆节', 'off'),
  { date: '2026-09-20', name: '国庆节', kind: 'workday' },
  { date: '2026-10-10', name: '国庆节', kind: 'workday' },
];

/** 当年收录的所有节假日表（未来年份在此追加）。 */
const TABLES_BY_YEAR: Record<string, HolidayDef[]> = { '2026': HOLIDAYS_2026 };

function isWeekend(dateKey: string): boolean {
  const wd = weekdayName(dateKey);
  return wd === '星期六' || wd === '星期日';
}

/**
 * dateKey（北京时间）是否休息日：
 * 命中调休表 → 按表判定；未收录年份 → 周末算休息日。
 */
export function isHoliday(dateKey: string): boolean {
  const year = dateKey.slice(0, 4);
  const hit = (TABLES_BY_YEAR[year] ?? []).find((h) => h.date === dateKey);
  if (hit) return hit.kind === 'off';
  return isWeekend(dateKey);
}

/**
 * 该日期所属年份是否已内置法定节假日表。
 * 未收录年份不会报错，只会静默退化为「仅周末算休息日」——
 * 春节/国庆这类挪休会判错，所以 /api/health 会暴露这个状态当哨兵。
 */
export function hasHolidayTable(dateKey: string): boolean {
  return (TABLES_BY_YEAR[dateKey.slice(0, 4)] ?? []).length > 0;
}

/** 一天的上下文描述（给 DeepSeek 看的"今天是什么日子"）。 */
export function describeDay(dateKey: string): { isHoliday: boolean; note: string } {
  const year = dateKey.slice(0, 4);
  const hit = (TABLES_BY_YEAR[year] ?? []).find((h) => h.date === dateKey);
  if (hit) {
    return hit.kind === 'off'
      ? { isHoliday: true, note: `${hit.name}假期` }
      : { isHoliday: false, note: `${hit.name}调休上班` };
  }
  if (isWeekend(dateKey)) return { isHoliday: true, note: '周末' };
  return { isHoliday: false, note: '工作日' };
}

export interface DayContext {
  date: string;
  weekday: string;
  is_holiday: boolean;
  holiday_note: string;
}

/** 组装当天上下文（不含天气，天气由 weather 模块另取）。 */
export function buildDayContext(dateKey: string): DayContext {
  const d = describeDay(dateKey);
  return {
    date: dateKey,
    weekday: weekdayName(dateKey),
    is_holiday: d.isHoliday,
    holiday_note: d.note,
  };
}
