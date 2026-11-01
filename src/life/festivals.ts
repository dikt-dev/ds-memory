/**
 * 节日表（C3 之后的 P3-6 收尾）。
 *
 * 分两档，不新造机制：
 *   小节日（中秋/端午/元宵/清明/重阳）——只在当天加一段吃的，别的不动
 *   大节日（除夕/春节/国庆）——给个标记，跨天旅行由旅行机制接手
 *
 * 只列了 2026–2028，农历节日按当年公历日期写死：算农历要引入历法库，
 * 而这张表三年才十几个日期，手写比引依赖便宜。
 */
export interface Festival {
  id: string;
  name: string;
  /** 小节日只吃；大节日可以出去玩 */
  size: 'small' | 'big';
  /** 当天要吃的那一口（小节日），写进日程标题 */
  eat?: string;
}

export const FESTIVALS: Record<string, Festival> = {
  '2026-02-16': { id: 'chuxi', name: '除夕', size: 'big' },
  '2026-02-17': { id: 'chunjie', name: '春节', size: 'big' },
  '2026-03-03': { id: 'yuanxiao', name: '元宵', size: 'small', eat: '煮汤圆' },
  '2026-04-05': { id: 'qingming', name: '清明', size: 'small', eat: '吃青团' },
  '2026-06-19': { id: 'duanwu', name: '端午', size: 'small', eat: '吃粽子' },
  '2026-09-25': { id: 'zhongqiu', name: '中秋', size: 'small', eat: '吃月饼' },
  '2026-10-01': { id: 'guoqing', name: '国庆', size: 'big' },
  '2026-10-18': { id: 'chongyang', name: '重阳', size: 'small', eat: '蒸重阳糕' },
  '2027-02-05': { id: 'chuxi', name: '除夕', size: 'big' },
  '2027-02-06': { id: 'chunjie', name: '春节', size: 'big' },
  '2027-02-20': { id: 'yuanxiao', name: '元宵', size: 'small', eat: '煮汤圆' },
  '2027-04-05': { id: 'qingming', name: '清明', size: 'small', eat: '吃青团' },
  '2027-06-09': { id: 'duanwu', name: '端午', size: 'small', eat: '吃粽子' },
  '2027-09-15': { id: 'zhongqiu', name: '中秋', size: 'small', eat: '吃月饼' },
  '2027-10-01': { id: 'guoqing', name: '国庆', size: 'big' },
  '2027-10-08': { id: 'chongyang', name: '重阳', size: 'small', eat: '蒸重阳糕' },
  '2028-01-25': { id: 'chuxi', name: '除夕', size: 'big' },
  '2028-01-26': { id: 'chunjie', name: '春节', size: 'big' },
  '2028-02-09': { id: 'yuanxiao', name: '元宵', size: 'small', eat: '煮汤圆' },
  '2028-04-04': { id: 'qingming', name: '清明', size: 'small', eat: '吃青团' },
  '2028-05-28': { id: 'duanwu', name: '端午', size: 'small', eat: '吃粽子' },
  '2028-10-03': { id: 'zhongqiu', name: '中秋', size: 'small', eat: '吃月饼' },
  '2028-10-01': { id: 'guoqing', name: '国庆', size: 'big' },
};

/** 当天是不是节日；不是就返回 null。 */
export function festivalOn(dateKey: string): Festival | null {
  return FESTIVALS[dateKey] ?? null;
}
