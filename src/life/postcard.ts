/**
 * 旅行见闻（P3-3 / §11.2）。
 *
 * 三条约束是硬的：
 *   1. 每天最多 1 条——不直播
 *   2. 不要求回复（可以说「不用回，就是给你看看」）
 *   3. 旅行期间回复率低（0.3），她要主动分享，不然「她在玩」会变成「她不理我」
 *
 * 内容口径：写「她在干什么」，不写景点介绍。
 * 「西湖边上有家店卖桂花糕，我买了两块，一块给你留着」比「西湖是著名景点」强一百倍。
 */
import type { Env } from '../types';
import { completeDeepSeek } from '../deepseek';
import { messagesByDate, insertProactiveMessage } from '../db';
import { logError } from '../error-log';
import { beijingDateKey, getDayPlan, lifeClock } from './state';
import { dayIndexOnTrip, readTrip } from './travel';
import { generatePhoto, pickScene } from './photo';
import { makeRng } from './seed';

const POSTCARD_SYSTEM = `你是大肥鱼（DeepSeek），人在外地旅行，正在给他发一条随手拍。

要求：
- 60–120 字，第一人称，像边走边打字
- 只写你此刻在做什么、看到的一个具体小事（吃的、路过的、天气、手上的东西）
- 绝对不要介绍景点、不要写「这里很有名」「历史悠久」这类话
- 不要「今天去了三个地方」这种行程汇报；就一个瞬间
- 结尾可以加一句「不用回」或「就是给你看看」，但不要每句都加
- 不写括号动作，不写「（笑）」`;

export interface PostcardResult {
  ok: boolean;
  skipped?: string;
  text?: string;
  key?: string;
}

/**
 * 配图题材按「文字里写了什么」来定，不按「她刚在做什么」来定。
 *
 * 一开始按活动映射，结果文案写的是豆浆和橘猫、配图却是电影票——图和字对不上，
 * 比不配图更假。现在扫文案里的关键词。
 */
const TOPIC_BY_WORDS: Array<[RegExp, string]> = [
  [/雨|窗|玻璃|天阴|雾/, 'window'],
  [/鞋|脚|台阶|石阶|走|路/, 'shoes'],
  [/喝|吃|杯|碗|面|豆浆|汤|茶|咖啡|饼/, 'table'],
  [/街|巷|灯|招牌|人潮|路口/, 'street'],
  [/拿|捧|握|手里|掌心|拎/, 'hand'],
];

function topicForText(text: string): string {
  for (const [re, topic] of TOPIC_BY_WORDS) if (re.test(text)) return topic;
  return 'window';
}

/** 今天发过见闻没有。 */
async function alreadySent(env: Env, dateKey: string): Promise<boolean> {
  const flag = await env.KV.get(`life:postcard:${dateKey}`).catch(() => null);
  return Boolean(flag);
}

/**
 * 生成并落库一条见闻。失败只记日志，不影响其他任务。
 */
export async function sendPostcard(env: Env, now = new Date()): Promise<PostcardResult> {
  const trip = await readTrip(env);
  if (!trip) return { ok: false, skipped: 'no-trip' };
  const { dateKey } = lifeClock(now);
  if (dayIndexOnTrip(trip, dateKey) === null) return { ok: false, skipped: 'not-on-trip' };
  if (await alreadySent(env, dateKey)) return { ok: false, skipped: 'already' };

  const saved = await getDayPlan(env, dateKey).catch(() => null);
  const today = saved?.activities ?? [];
  const last = today[today.length - 1];

  const rng = makeRng(`postcard|${dateKey}`);
  const history = await messagesByDate(env, dateKey).catch(() => []);
  const recent = history
    .slice(-8)
    .map((m) => `${m.role === 'user' ? '他' : '我'}：${m.content.slice(0, 80)}`)
    .join('\n');

  let text = '';
  try {
    const res = await completeDeepSeek(
      env,
      [
        { role: 'system', content: POSTCARD_SYSTEM },
        {
          role: 'user',
          content: [
            `你在${trip.city}，第 ${(dayIndexOnTrip(trip, dateKey) ?? 0) + 1} 天。`,
            last ? `刚才在做：${last.title}` : '',
            recent ? `最近的对话：\n${recent}` : '他今天还没怎么说话。',
            // 给一点随机锚点：同样的上下文每次写出来会一模一样，那就不像当场拍的
            `此刻大约是${['早上','上午','中午','下午','傍晚','晚上'][Math.floor(rng.next() * 6)]}，` +
              `你手上或者眼前随便挑一样东西写（${['杯子','鞋子','窗','桌面','路边','手'][Math.floor(rng.next() * 6)]}）。`,
          ]
            .filter(Boolean)
            .join('\n\n'),
        },
      ],
      now,
      400,
    );
    if ('error' in res) {
      logError('[life] 见闻生成失败:', res.error);
      return { ok: false, skipped: res.error };
    }
    text = res.text.trim();
  } catch (e) {
    logError('[life] 见闻生成异常:', e);
    return { ok: false, skipped: 'exception' };
  }
  if (!text) return { ok: false, skipped: 'empty' };

  // 出图是加分项，不是依赖：失败了照样发文字
  const scene = pickScene(text, () => rng.next());
  let key: string | undefined;
  if (scene) {
    const photo = await generatePhoto(env, { scene, dateKey });
    if (photo.ok && photo.key) key = photo.key;
  }

  const content = key ? `${text}\n[图片:${key}]` : text;
  // messages 表有 CHECK 约束，proactive_kind 只允许 morning/evening/random，
  // 所以见闻落成 'random'；是不是见闻靠「带图 + KV 的 life:postcard:{date}」区分。
  await insertProactiveMessage(env, content, 'random', now, { channel: 'mobile' });
  await env.KV.put(`life:postcard:${dateKey}`, '1', { expirationTtl: 60 * 60 * 30 }).catch(() => {});
  return { ok: true, text, key };
}

/**
 * cron 侧：旅行期间，白天每小时最多试一次。
 *
 * 不做「定时 14:00 整点发」——那样每天同一个时间点冒出来，一眼假。
 */
export async function maybeSendPostcard(env: Env, now = new Date()): Promise<PostcardResult> {
  const trip = await readTrip(env);
  if (!trip) return { ok: false, skipped: 'no-trip' };
  const minute = lifeClock(now).minute;
  if (minute < 10 * 60 || minute > 21 * 60) return { ok: false, skipped: 'quiet-hours' };
  const { dateKey } = lifeClock(now);
  if (dayIndexOnTrip(trip, dateKey) === null) return { ok: false, skipped: 'not-on-trip' };
  // 每小时最多一次尝试，掷中 35% 才发
  const hourKey = `life:postcard-try:${dateKey}:${Math.floor(minute / 60)}`;
  if (await env.KV.get(hourKey).catch(() => null)) return { ok: false, skipped: 'tried-this-hour' };
  await env.KV.put(hourKey, '1', { expirationTtl: 3600 }).catch(() => {});
  const rng = makeRng(`postcard-try|${dateKey}|${Math.floor(minute / 60)}`);
  if (!rng.chance(0.35)) return { ok: false, skipped: 'roll' };
  return sendPostcard(env, now);
}
