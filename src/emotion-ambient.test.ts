import { describe, expect, it } from 'vitest';
import { ambientFrom, withAmbient } from './emotion-ambient';

describe('白天的底色', () => {
  it('下午最活跃，凌晨最蔫', () => {
    const afternoon = ambientFrom({ hour: 15, weather: 'cloudy', moodSeed: 0.5 });
    const night = ambientFrom({ hour: 3, weather: 'cloudy', moodSeed: 0.5 });
    expect(afternoon.arousal).toBeGreaterThan(night.arousal);
    expect(afternoon.arousal).toBeGreaterThanOrEqual(20);
    expect(night.arousal).toBeLessThanOrEqual(10);
  });

  it('晴天抬心情，雨雪压低', () => {
    const sun = ambientFrom({ hour: 15, weather: 'sunny', moodSeed: 0.5 });
    const rain = ambientFrom({ hour: 15, weather: 'rain', moodSeed: 0.5 });
    expect(sun.valence).toBeGreaterThan(rain.valence);
  });

  it('当天心情种子会带着走', () => {
    const good = ambientFrom({ hour: 15, weather: 'cloudy', moodSeed: 0.8 });
    const bad = ambientFrom({ hour: 15, weather: 'cloudy', moodSeed: 0.2 });
    expect(good.arousal).toBeGreaterThan(bad.arousal);
    expect(good.valence).toBeGreaterThan(bad.valence);
  });

  it('叠加只抬不压：已有的高唤醒不会被盖掉', () => {
    const base = { valence: 10, arousal: 60, dominance: 0, attachment: 0, jealousy: 0, grievance: 0, shyness: 0, fatigue: 0 };
    const out = withAmbient(base, { arousal: 20, valence: 3, note: '' });
    expect(out.arousal).toBe(60);
    expect(out.valence).toBe(13);
  });
});
