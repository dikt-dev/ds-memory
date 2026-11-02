/**
 * 营业时间：只给「有门的店」用。
 *
 * 商场 10 点前不可能是营业的，菜市场也不会凌晨三点开——
 * 但公园、散步、超市这种随时能去的不在这里，别把一天排死。
 *
 * 单位是分钟（从 0 点算），闭区间是 [开门, 打烊)。打烊前 30 分钟也算进不去。
 */
export const OPENING_HOURS: Record<string, [number, number]> = {
  outing_mall: [10 * 60, 22 * 60],
  outing_cafe: [8 * 60, 22 * 60],
  outing_bookstore: [9 * 60, 21 * 60],
  outing_supermarket: [8 * 60, 22 * 60],
  grocery: [8 * 60, 22 * 60],
  outing_market: [16 * 60, 23 * 60],
  outing_haircut: [9 * 60, 20 * 60],
  outing_pharmacy: [8 * 60, 23 * 60],
  outing_park: [6 * 60, 20 * 60],
  short_trip_amusement: [10 * 60, 21 * 60],
  short_trip_hotspring: [10 * 60, 23 * 60],
  short_trip_hike: [6 * 60, 18 * 60],
};

/** 这个点能不能进这家店（只能判断开始时间，进去之后待到几点不管）。 */
export function openAt(unitId: string, minute: number): boolean {
  const hours = OPENING_HOURS[unitId];
  if (!hours) return true;
  return minute >= hours[0] && minute <= hours[1] - 30;
}
