/**
 * 白天的「底色」：让唤醒度有个随时间和环境起伏的基线。
 *
 * 为什么需要：事件给的 arousal 撑不过一个半小时，一天里大部分时间是 0，
 * 她整个人就一直是那副提不起劲的平调。这里补一个**只影响提示词、不写库**的底色：
 *   - 时间：早晨低、下午高、深夜最低
 *   - 天气：晴 +4、阴 0、雨/雪 -3
 *   - 心情：当天 mood_seed 高 +5、低 -4
 *
 * 只在拼快照时叠加，不回写 runtime_state —— 否则每轮读一次写一次会一路漂上去。
 */
import type { Env } from './types';
import { dateKeyInBeijing } from './date';
import { beijingMinutes } from './proactive';
import type { EmotionVector } from './emotion-vector';

export interface Ambient {
  /** 这个时段的唤醒度基线 */
  arousal: number;
  hour: number;
  weather: string | null;
  /** 对好心情的偏移（小幅度，只影响观感） */
  valence: number;
  /** 一句话说明，排查时看 */
  note: string;
}

/** 时间曲线：按北京时间给一个基础唤醒度。 */
function timeArousal(hour: number): number {
  if (hour >= 1 && hour < 6) return 6;      // 凌晨：最蔫
  if (hour >= 6 && hour < 9) return 12;     // 早起：还没完全醒
  if (hour >= 9 && hour < 12) return 18;    // 上午：精神
  if (hour >= 12 && hour < 14) return 13;   // 饭后犯困
  if (hour >= 14 && hour < 18) return 22;   // 下午：一天里最活跃
  if (hour >= 18 && hour < 22) return 17;   // 傍晚
  return 10;                                // 22–1 点：困了
}

function weatherValence(weather: string | null | undefined): number {
  const w = (weather ?? '').toLowerCase();
  if (w.includes('sun')) return 4;
  if (w.includes('rain') || w.includes('snow') || w.includes('fog')) return -3;
  return 0;
}

export function ambientFrom(input: {
  hour: number;
  weather?: string | null;
  moodSeed?: number | null;
}): Ambient {
  const { hour, weather, moodSeed } = input;
  let arousal = timeArousal(hour);
  let valence = weatherValence(weather);
  const mood = typeof moodSeed === 'number' ? moodSeed : 0.5;
  if (mood >= 0.65) {
    arousal += 4;
    valence += 3;
  } else if (mood <= 0.35) {
    arousal -= 3;
    valence -= 3;
  }
  arousal = Math.min(Math.max(Math.round(arousal), 5), 30);
  valence = Math.min(Math.max(Math.round(valence), -8), 8);
  return { arousal, valence, hour, weather: weather ?? null, note: `${hour}点/${weather ?? '-'}/mood${mood.toFixed(2)}` };
}

/** 读当天的天气与心情种子；读不到就按默认算。 */
export async function readAmbient(env: Env, now: Date): Promise<Ambient> {
  const hour = Math.floor(beijingMinutes(now) / 60) % 24;
  const row = await env.DB.prepare('SELECT weather, mood_seed FROM ai_day WHERE date_key = ?')
    .bind(dateKeyInBeijing(now))
    .first<{ weather: string | null; mood_seed: number | null }>()
    .catch(() => null);
  return ambientFrom({ hour, weather: row?.weather ?? null, moodSeed: row?.mood_seed ?? null });
}

/** 把底色叠到情绪向量上：唤醒度取较高者（幂等），好坏感受小幅偏移。 */
export function withAmbient(vector: EmotionVector, ambient: Ambient): EmotionVector {
  return {
    ...vector,
    arousal: Math.max(vector.arousal, ambient.arousal),
    valence: Math.min(Math.max(vector.valence + ambient.valence, -100), 100),
  };
}

/** 一句话描述这个时段的底色（进快照，给他看的） */
export function describeAmbient(ambient: Ambient): string {
  const h = ambient.hour;
  const when = h >= 5 && h < 9 ? '早上' : h >= 9 && h < 12 ? '上午' : h >= 12 && h < 14 ? '中午'
    : h >= 14 && h < 18 ? '下午' : h >= 18 && h < 22 ? '晚上' : '深夜';
  const energy = ambient.arousal >= 24 ? '精神头挺足' : ambient.arousal >= 18 ? '还算有精神'
    : ambient.arousal >= 12 ? '有点懒' : '困劲儿上来了';
  const w = (ambient.weather ?? '').toLowerCase();
  const mood = w.includes('sun') ? '，外面太阳不错' : w.includes('rain') ? '，外面在下雨'
    : w.includes('snow') ? '，外面下雪' : w.includes('cloud') ? '，天有点阴' : '';
  return `${when}这会儿${energy}${mood}`;
}
