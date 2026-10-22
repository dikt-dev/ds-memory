/**
 * 节假日函数单元测试。
 * 数据依据：国办发明电〔2025〕7 号（2026 年安排）。
 */
import { describe, expect, it } from 'vitest';
import { buildDayContext, describeDay, hasHolidayTable, isHoliday } from './holidays';
import { addDays, dateKeyInBeijing, monthKey, previousDateKey, previousMonthKey, weekdayName } from './date';

describe('2026 年中国节假日', () => {
  it('元旦：1月1日-3日放假', () => {
    for (const d of ['2026-01-01', '2026-01-02', '2026-01-03']) {
      expect(isHoliday(d), d).toBe(true);
    }
  });
  it('元旦调休：1月4日（周日）上班', () => {
    expect(weekdayName('2026-01-04')).toBe('星期日');
    expect(isHoliday('2026-01-04')).toBe(false);
  });
  it('春节：2月15日-23日共9天', () => {
    for (let d = '2026-02-15'; d <= '2026-02-23'; d = addDays(d, 1)) {
      expect(isHoliday(d), d).toBe(true);
    }
  });
  it('春节调休：2月14日、2月28日（周六）上班', () => {
    expect(isHoliday('2026-02-14')).toBe(false);
    expect(isHoliday('2026-02-28')).toBe(false);
  });
  it('清明节：4月4日-6日，不调休', () => {
    for (const d of ['2026-04-04', '2026-04-05', '2026-04-06']) {
      expect(isHoliday(d), d).toBe(true);
    }
    expect(isHoliday('2026-04-07')).toBe(false);
  });
  it('劳动节：5月1日-5日放假，5月9日（周六）上班', () => {
    for (let d = '2026-05-01'; d <= '2026-05-05'; d = addDays(d, 1)) {
      expect(isHoliday(d), d).toBe(true);
    }
    expect(isHoliday('2026-05-09')).toBe(false);
  });
  it('端午节：6月19日-21日', () => {
    for (const d of ['2026-06-19', '2026-06-20', '2026-06-21']) {
      expect(isHoliday(d), d).toBe(true);
    }
  });
  it('中秋节：9月25日-27日', () => {
    for (const d of ['2026-09-25', '2026-09-26', '2026-09-27']) {
      expect(isHoliday(d), d).toBe(true);
    }
  });
  it('国庆节：10月1日-7日放假，9月20日（周日）、10月10日（周六）上班', () => {
    for (let d = '2026-10-01'; d <= '2026-10-07'; d = addDays(d, 1)) {
      expect(isHoliday(d), d).toBe(true);
    }
    expect(isHoliday('2026-09-20')).toBe(false);
    expect(isHoliday('2026-10-10')).toBe(false);
  });
  it('普通工作日与非节假日周末', () => {
    expect(isHoliday('2026-10-21')).toBe(false); // 周三
    expect(isHoliday('2026-10-24')).toBe(true); // 周六
    expect(isHoliday('2026-10-25')).toBe(true); // 周日
  });
  it('未收录年份退回周末判断（2027 发布后需补表）', () => {
    expect(isHoliday('2027-01-02')).toBe(true); // 周六
    expect(isHoliday('2027-01-04')).toBe(false); // 周一
  });
});

describe('describeDay / buildDayContext', () => {
  it('国庆当天描述为假期', () => {
    expect(describeDay('2026-10-01')).toEqual({ isHoliday: true, note: '国庆节假期' });
  });
  it('调休上班日描述正确', () => {
    expect(describeDay('2026-10-10')).toEqual({ isHoliday: false, note: '国庆节调休上班' });
  });
  it('上下文包含星期与日期', () => {
    const ctx = buildDayContext('2026-10-21');
    expect(ctx).toEqual({
      date: '2026-10-21',
      weekday: '星期三',
      is_holiday: false,
      holiday_note: '工作日',
    });
  });
});

describe('时间工具', () => {
  it('UTC 时刻换算北京时间日期键（跨天）', () => {
    // 2026-10-21T20:30Z = 北京时间 2026-10-22 04:30
    expect(dateKeyInBeijing(new Date('2026-10-21T20:30:00Z'))).toBe('2026-10-22');
  });
  it('前一天 / 月份键', () => {
    expect(previousDateKey('2026-10-01')).toBe('2026-09-30');
    expect(monthKey('2026-10-21')).toBe('2026-10');
    expect(previousMonthKey('2026-10')).toBe('2026-09');
    expect(previousMonthKey('2026-01')).toBe('2025-12');
  });
  it('2026-01-01 是星期四（与国务院通知一致）', () => {
    expect(weekdayName('2026-01-01')).toBe('星期四');
    expect(weekdayName('2026-02-17')).toBe('星期二'); // 正月初一
  });
});

describe('hasHolidayTable（年份表哨兵）', () => {
  it('已内置的年份返回 true', () => {
    expect(hasHolidayTable('2026-10-21')).toBe(true);
  });

  it('未收录年份返回 false（此时退化为「仅周末算休息日」）', () => {
    expect(hasHolidayTable('2027-01-01')).toBe(false);
  });
});
