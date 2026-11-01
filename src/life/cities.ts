/** 12 个城市（§6.1 已定）。单独成文件：weather 和 travel 都要用，放一起会循环引用。 */
export const CITIES: Record<string, { lat: number; lon: number }> = {
  北京: { lat: 39.9, lon: 116.41 },
  上海: { lat: 31.23, lon: 121.47 },
  杭州: { lat: 30.27, lon: 120.16 },
  苏州: { lat: 31.3, lon: 120.58 },
  成都: { lat: 30.57, lon: 104.07 },
  重庆: { lat: 29.56, lon: 106.55 },
  西安: { lat: 34.34, lon: 108.94 },
  厦门: { lat: 24.48, lon: 118.09 },
  青岛: { lat: 36.07, lon: 120.38 },
  大理: { lat: 25.61, lon: 100.27 },
  长沙: { lat: 28.23, lon: 112.94 },
  南京: { lat: 32.06, lon: 118.8 },
};
