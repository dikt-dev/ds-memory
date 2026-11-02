/**
 * 在家里发生的事，写在哪个房间。
 *
 * 以前日程只有「做饭」「看剧」，没有地点，问「你在哪」她答不出具体房间；
 * 现在至少能说「在厨房」「在阳台」。
 *
 * 只在 atHome 时生效：出门在外，活动本身就是地点（咖啡馆、公园）。
 */
const ROOMS: Record<string, string> = {
  cook_meal: '厨房',
  bake: '厨房',
  dishes: '厨房',
  meal_normal: '厨房',
  meal_takeout: '客厅',
  meal_snack: '客厅',
  meal_night: '厨房',
  anime_series: '客厅',
  anime_movie: '客厅',
  anime_rewatch: '客厅',
  anime_marathon: '客厅',
  game_roguelike: '客厅',
  game_cozy: '客厅',
  game_mobile: '床上',
  game_boss_retry: '客厅',
  draw: '书桌',
  journal_write: '书桌',
  learn_guitar: '阳台',
  learn_cook: '厨房',
  plant_care: '阳台',
  puzzle: '客厅',
  photo_edit: '书桌',
  clean_room: '卧室',
  clean_deep: '卫生间',
  laundry: '阳台',
  organize: '衣柜',
  fix_thing: '客厅',
  idle_phone: '床上',
  idle_nap: '床上',
  idle_window: '窗边',
  idle_music: '客厅',
  idle_bath: '卫生间',
  idle_shower: '卫生间',
  idle_dress: '卧室',
  rainy_window: '窗边',
};

/** 这个活动发生在哪个房间；没写就是没有具体地点。 */
export function placeFor(unitId: string, atHome: boolean): string | null {
  if (!atHome) return null;
  return ROOMS[unitId] ?? null;
}
