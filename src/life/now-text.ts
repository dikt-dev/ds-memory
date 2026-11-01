/**
 * 「她此刻在干什么」——喂给提示词的那一小段。
 *
 * 没有这段的时候，她不知道自己今天病了、也不知道刚才在电影院：
 * 日程在库里是自洽的，但她本人看不见，一开口就是「我在家看书」。
 *
 * 三条原则：
 *   1. 只给事实，不给台词。别写成「你感冒了，说：咳…」——那样每轮都在演同一个小品。
 *   2. 状态差的时候才多说一句（病了、熬夜了），平常就一行。
 *   3. 明确禁止复述「我 13:20 在看书」这种日程口吻，那是在念表格。
 */
import type { Env } from '../types';
import { beijingDateKey, lifeClock, statusAt } from './state';

function hhmm(minute: number): string {
  const m = minute % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/**
 * 当天的基调（C3）。
 *
 * mood_seed 是一直在算、一直落库、却没人读的那个字段。它不该新造一套情绪系统，
 * 只该给当天的话染一点底色：晴天出门的日子话多一点，大扫除/生病的话淡一点。
 */
function moodLine(mood: number | null): string | null {
  if (typeof mood !== 'number' || Number.isNaN(mood)) return null;
  if (mood > 0.35) return '你今天心情是亮的，说话带点轻快，愿意多说两句。';
  if (mood < -0.35) return '你今天心情有点闷，话不那么多，别硬撑着热情。';
  return null;
}

function bodyLine(health: number, recipe: string | null): string | null {
  if (recipe === 'sick' || health < 60) {
    return '你今天病着，低烧、浑身发软，一整天基本躺着。说话短一点、慢一点，别逞强装没事；可以顺口提一句不舒服，但别反复诉苦，也别主动要人照顾。';
  }
  if (health < 80) return '你今天身体有点沉，不算病，就是没精神。';
  if (recipe === 'marathon') return '你昨晚通宵了，今天脑子是糊的，反应会慢半拍。';
  return null;
}

/** 返回给提示词的一小段（没有当天日程就返回 null，聊天行为和以前完全一致）。 */
export async function lifePromptLine(env: Env, now = new Date()): Promise<string | null> {
  const { dateKey, minute } = lifeClock(now);
  const day = await env.DB.prepare(
    'SELECT recipe, health, weather, temp_c, location, mood_seed FROM ai_day WHERE date_key = ?',
  )
    .bind(dateKey)
    .first<{ recipe: string | null; health: number; weather: string | null; temp_c: number | null; location: string | null; mood_seed: number | null }>()
    .catch(() => null);
  if (!day) return null;

  const acts = await env.DB.prepare(
    'SELECT unit_id, kind, title, start_min, end_min, interruptible FROM ai_activity WHERE date_key = ? ORDER BY start_min',
  )
    .bind(dateKey)
    .all<{ unit_id: string; kind: string; title: string; start_min: number; end_min: number; interruptible: number }>()
    .catch(() => null);
  const status = statusAt(
    (acts?.results ?? []).map((a) => ({
      date_key: dateKey,
      start_min: a.start_min,
      end_min: a.end_min,
      unit_id: a.unit_id,
      kind: a.kind,
      title: a.title,
      interruptible: a.interruptible,
    })) as never,
    minute,
    day.health,
  );

  const bits: string[] = [];
  const where = day.location ? `你在${day.location}` : '';
  if (status.current) {
    bits.push(
      `现在是 ${hhmm(minute)}，${where}，${status.current.title}（${hhmm(status.current.start_min)}–${hhmm(status.current.end_min)}）`,
    );
  } else if (status.next) {
    bits.push(`现在是 ${hhmm(minute)}，${where}，暂时没事做，${hhmm(status.next.start_min)} 打算${status.next.title}`);
  } else {
    bits.push(`现在是 ${hhmm(minute)}，${where}`);
  }
  if (day.weather) {
    const t = typeof day.temp_c === 'number' ? `${Math.round(day.temp_c)}℃` : '';
    bits.push(`外面${day.weather === 'rain' ? '在下雨' : day.weather === 'snow' ? '在下雪' : day.weather === 'sunny' ? '是晴天' : '阴着'} ${t}`.trim());
  }
  const mood = moodLine(day.mood_seed ?? null);
  if (mood) bits.push(mood);
  const body = bodyLine(day.health, day.recipe);
  if (body) bits.push(body);

  return [
    '【你此刻的状态】（事实参考，别逐字复述，也别用「日程」「安排」这类词）',
    ...bits.map((b) => '- ' + b),
  ].join('\n');
}

/** 诊断用：当天有没有日程。 */
export async function hasDayPlan(env: Env, now = new Date()): Promise<boolean> {
  const { dateKey } = lifeClock(now);
  const row = await env.DB.prepare('SELECT date_key FROM ai_day WHERE date_key = ?').bind(beijingDateKey(now) || dateKey).first().catch(() => null);
  return Boolean(row);
}
