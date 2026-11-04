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
import { diaryPeopleBlock } from './residents';
import { buildDayContext } from '../holidays';

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
/** 今天日程里有社交对象时给一张卡片；没有就返回 null（提示词一字不变）。 */
export async function residentNowLine(env: Env, now = new Date()): Promise<string | null> {
  const dateKey = lifeClock(now).dateKey;
  const row = await env.DB.prepare('SELECT people FROM ai_day WHERE date_key = ?')
    .bind(dateKey)
    .first<{ people: string | null }>()
    .catch(() => null);
  const block = diaryPeopleBlock(row?.people ?? null);
  if (!block) return null;
  return block.split('\n')[0] === '' ? null : block;
}

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
    'SELECT unit_id, kind, title, start_min, end_min, interruptible, reply_chance FROM ai_activity WHERE date_key = ? ORDER BY start_min',
  )
    .bind(dateKey)
    .all<{ unit_id: string; kind: string; title: string; start_min: number; end_min: number; interruptible: number; reply_chance: number | null }>()
    .catch(() => null);
  const actRows = (acts?.results ?? []).map((a) => ({
      date_key: dateKey,
      start_min: a.start_min,
      end_min: a.end_min,
      unit_id: a.unit_id,
      kind: a.kind,
      title: a.title,
      interruptible: a.interruptible,
      reply_chance: a.reply_chance ?? 1,
  }));
  const status = statusAt(actRows as never, minute, day.health);

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
  // 位置/活动一致性：模型容易把记忆里的活动塞进此刻，实测出现过「在超市里说刚追完一集番」
  if (status.current) {
    bits.push('这一条是你此刻唯一的位置和活动；不要在同一轮里描述自己在别处做别的事');
    // 能不能被打断：字段一直在库里算，却从没进过提示词——
    // 结果她在电影院也能长篇秒回，像随时待命的客服。
    const absorbing =
      status.current.interruptible === 0 || (status.current.reply_chance ?? 1) < 0.2;
    bits.push(
      absorbing
        ? '这阵子多半不看手机，回消息会拖着；真抽空回也是短短一句，别写长'
        : '这件事随时能停下，他找你你就能腾出手',
    );
  }
  // 今天是不是节假日：她得知道"今天不用上班"和"今天周三"的区别

  // 之后还要做什么：只给今天剩下的两三件，别把整张表念出来
  {
    const rest = actRows
      .filter((a) => a.start_min > minute)
      // 没在做事的空档，下一件事上面那句已经说过了，别重复
      .filter((a) => !(status.next && a.start_min === status.next.start_min))
      .slice(0, 3);
    if (rest.length > 0) {
      bits.push(
        '接下来：' + rest.map((a) => `${hhmm(a.start_min)} ${a.title}`).join('、'),
      );
    } else if (status.current) {
      bits.push('今天剩下的时间没什么安排，都是自己的');
    }
  }
  // 位置不在这里写：聊天块（chat-blocks）每轮都带一句【位置】，写两遍她会来回强调。

  const mood = moodLine(day.mood_seed ?? null);
  if (mood) bits.push(mood);
  const body = bodyLine(day.health, day.recipe);
  if (body) bits.push(body);

  return [
    '【日程】（事实参考，别逐字复述，也别用「日程」「安排」这类词）',
    ...bits.map((b) => '- ' + b),
  ].join('\n');
}

/** 诊断用：当天有没有日程。 */
export async function hasDayPlan(env: Env, now = new Date()): Promise<boolean> {
  const { dateKey } = lifeClock(now);
  const row = await env.DB.prepare('SELECT date_key FROM ai_day WHERE date_key = ?').bind(beijingDateKey(now) || dateKey).first().catch(() => null);
  return Boolean(row);
}
