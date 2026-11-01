/**
 * 生活系统的定时与查询入口（P0-B4 / P0-C1）。
 *
 * P0 阶段只写库、不读——聊天完全不受影响（见 life-build-plan.md）。
 */
import type { Env } from '../types';
import {
  beijingDateKey,
  ensureDayPlan,
  lifeClock,
  shiftDate,
  statusAt,
  type ActivityRow,
  type NowStatus,
} from './state';
import type { DayEnv } from './types';
import { generateDiary } from './diary-job';
import { refreshLifeEnv } from './weather';
import { readTrip } from './travel';
import { appendMemoryLine } from '../memory-append';

/** 天气/位置的输入。P1 之前从 KV 读，没有就用默认值。 */
export interface LifeInput {
  location: string;
  atHome: boolean;
  weather: string;
  tempC: number;
}

const DEFAULT_INPUT: LifeInput = { location: '北京', atHome: true, weather: 'cloudy', tempC: 20 };

/**
 * 读当天的环境输入（P1 接真实天气）。
 *
 * KV 键：life:env:{dateKey}，值是 JSON。没有就回退默认值——
 * 宁可日程按「阴天 20 度在家」生成，也不要因为天气接口挂了就没有日程。
 */
export async function readLifeInput(env: Env, dateKey: string): Promise<LifeInput> {
  const raw = await env.KV.get(`life:env:${dateKey}`).catch(() => null);
  if (!raw) return DEFAULT_INPUT;
  try {
    const parsed = JSON.parse(raw) as Partial<LifeInput>;
    return {
      location: typeof parsed.location === 'string' && parsed.location ? parsed.location : DEFAULT_INPUT.location,
      atHome: parsed.atHome !== false,
      weather: typeof parsed.weather === 'string' && parsed.weather ? parsed.weather : DEFAULT_INPUT.weather,
      tempC: typeof parsed.tempC === 'number' ? parsed.tempC : DEFAULT_INPUT.tempC,
    };
  } catch {
    return DEFAULT_INPUT;
  }
}

/** 生成并落库某一天的计划（幂等）。 */
export async function ensureLifeDay(
  env: Env,
  dateKey: string,
): Promise<{ created: boolean; activities: number }> {
  // 行程可能在生成「回家日」时被清掉，所以先留一份，回来时好写进记忆
  const tripBefore = await readTrip(env).catch(() => null);
  const input = await readLifeInput(env, dateKey);
  const dayEnv: DayEnv = { weather: input.weather, tempC: input.tempC, atHome: input.atHome };
  const before = await env.DB.prepare('SELECT date_key FROM ai_day WHERE date_key = ?')
    .bind(dateKey)
    .first<{ date_key: string }>();
  const saved = await ensureDayPlan(env, {
    dateKey,
    env: dayEnv,
    location: input.location,
  });
  // 回家日：把这次旅行写进「共同经历」——不然她以后说「上次去杭州」就是编的
  if (saved.day.recipe === 'homecoming' && tripBefore) {
    const end = shiftDate(tripBefore.start, tripBefore.days - 1);
    const line =
      tripBefore.days > 1
        ? `- ${tripBefore.start} 到 ${end} 去了${tripBefore.city}，待了 ${tripBefore.days} 天`
        : `- ${tripBefore.start} 去了${tripBefore.city}`;
    await appendMemoryLine(env, {
      section: '## 共同经历',
      line,
      keyword: tripBefore.city,
      actor: 'job',
    }).catch(() => {});
  }

  return { created: !before, activities: saved.activities.length };
}

/** 每天 04:00 的 cron：生成「今天」的日程。 */
export async function runDailyLife(env: Env, now = new Date()): Promise<void> {
  const dateKey = beijingDateKey(now);
  await ensureLifeDay(env, dateKey);
}

/** 现在是什么状态（状态栏 + 状态页用）。 */
export async function lifeNow(env: Env, now = new Date()): Promise<NowStatus & { dateKey: string }> {
  const { dateKey, minute } = lifeClock(now);
  const input = await readLifeInput(env, dateKey);
  const dayEnv: DayEnv = { weather: input.weather, tempC: input.tempC, atHome: input.atHome };
  const saved = await ensureDayPlan(env, { dateKey, env: dayEnv, location: input.location });
  const activities: ActivityRow[] = saved.activities;
  return { dateKey, ...statusAt(activities, minute, saved.day.health) };
}

/**
 * 每天 04:00 给「昨天」写日记。
 *
 * 她的一天到次日 02:00 才结束，04:00 落笔时素材刚好齐；再早会漏掉夜里那段。
 */
export async function runLifeDiary(env: Env, now = new Date()): Promise<void> {
  const today = beijingDateKey(now);
  const yesterday = shiftDate(today, -1);
  await generateDiary(env, yesterday).catch(() => {});
}

/** 04:00 先刷天气再生成日程：装填要知道今天下不下雨。 */
export async function runLifeMorning(env: Env, now = new Date()): Promise<void> {
  const dateKey = beijingDateKey(now);
  await refreshLifeEnv(env, dateKey).catch(() => {});
  await ensureLifeDay(env, dateKey);
  await runLifeDiary(env, now);
}
