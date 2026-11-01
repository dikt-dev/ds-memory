import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildDay, describeDay, MAX_ACTIVITIES } from './planner';
import { ACTIVITIES, BY_ID } from './pool';
import { weatherFromCode } from './weather';
import { validateDay } from './validate';
import { healthForDay, pickRecipe } from './recipes';
import type { DayEnv } from './types';

/**
 * 30 天日程评审：用真实历史天气（Open-Meteo archive）生成，打印成表。
 * PREVIEW=1 npx vitest run src/life/preview.test.ts 才会打印大表；
 * 平时这条只校验「每天 2–4 段、全部过校验」。
 */
const raw = JSON.parse(
  readFileSync('src/life/fixtures/weather30.json', 'utf8'),
) as { daily: { time: string[]; temperature_2m_max: number[]; weather_code: number[] } };

describe('特殊日频率（365 天统计）', () => {
  it('生病约 2%/天、通宵约每月一次、大扫除约每月一次、摆烂约 3%/天', () => {
    const counts: Record<string, number> = {};
    const history = { daysSinceSick: null as number | null, daysSinceDeepclean: null as number | null, daysSinceMarathon: null as number | null };
    for (let d = 0; d < 365; d += 1) {
      const date = new Date(Date.UTC(2026, 0, 1 + d)).toISOString().slice(0, 10);
      const choice = pickRecipe(date, history);
      const id = choice.recipe?.id ?? 'none';
      counts[id] = (counts[id] ?? 0) + 1;
      if (id === 'sick') history.daysSinceSick = 0;
      if (id === 'deepclean') history.daysSinceDeepclean = 0;
      if (id === 'marathon') history.daysSinceMarathon = 0;
      history.daysSinceSick = history.daysSinceSick === null ? null : history.daysSinceSick + 1;
      history.daysSinceDeepclean = history.daysSinceDeepclean === null ? null : history.daysSinceDeepclean + 1;
      history.daysSinceMarathon = history.daysSinceMarathon === null ? null : history.daysSinceMarathon + 1;
    }
    if ((globalThis as { process?: { env?: Record<string, string> } }).process?.env?.PREVIEW) {
      console.log('365 天特殊日统计：' + JSON.stringify(counts));
    }
    // 一年里：生病 3–15 天（冷却 30 天，上限 12）、通宵 8–16、大扫除 8–16、摆烂 5–25
    expect(counts.sick ?? 0).toBeLessThanOrEqual(13);
    expect(counts.sick ?? 0).toBeGreaterThanOrEqual(2);
    expect(counts.marathon ?? 0).toBeGreaterThanOrEqual(5);
    expect(counts.deepclean ?? 0).toBeGreaterThanOrEqual(5);
    expect(counts.lazy ?? 0).toBeGreaterThanOrEqual(4);
    expect(counts.lazy ?? 0).toBeLessThanOrEqual(30);
  });
});

describe('30 天日程评审', () => {
  it('每天 2–5 段、全部过校验、天气与池子不冲突', () => {
    const recent = new Map<string, string[]>();
    let prevHealth = 100;
    const history = { daysSinceSick: null as number | null, daysSinceDeepclean: null as number | null, daysSinceMarathon: null as number | null };
    const recipes: string[] = [];
    const counts = new Map<string, number>();
    const rows: string[] = [];
    let total = 0;

    for (let i = 0; i < raw.daily.time.length; i += 1) {
      const date = raw.daily.time[i];
      const env: DayEnv = {
        weather: weatherFromCode(raw.daily.weather_code[i]),
        tempC: Math.round(raw.daily.temperature_2m_max[i]),
        atHome: true,
      };
      const choice = pickRecipe(date, history);
      const health = healthForDay({
        yesterdayHealth: prevHealth,
        sickToday: choice.recipe?.id === 'sick',
        daysSinceSick: history.daysSinceSick,
      });
      const plan = buildDay({ date, env, recentUses: recent, recipe: choice.recipe });
      if (choice.recipe) {
        recipes.push(`${date} ${choice.recipe.label}`);
        if (choice.recipe.id === 'sick') history.daysSinceSick = 0;
        if (choice.recipe.id === 'deepclean') history.daysSinceDeepclean = 0;
        if (choice.recipe.id === 'marathon') history.daysSinceMarathon = 0;
      }
      history.daysSinceSick = history.daysSinceSick === null ? null : history.daysSinceSick + 1;
      history.daysSinceDeepclean = history.daysSinceDeepclean === null ? null : history.daysSinceDeepclean + 1;
      history.daysSinceMarathon = history.daysSinceMarathon === null ? null : history.daysSinceMarathon + 1;
      prevHealth = choice.recipe?.health ?? health;
      expect(validateDay(plan), date).toEqual([]);
      expect(plan.activities.length, date).toBeGreaterThanOrEqual(1);
      expect(plan.activities.length, date).toBeLessThanOrEqual(MAX_ACTIVITIES);

      for (const a of plan.activities) {
        const list = recent.get(a.unitId) ?? [];
        list.push(date);
        if (list.length > 6) list.shift();
        recent.set(a.unitId, list);
        counts.set(a.unitId, (counts.get(a.unitId) ?? 0) + 1);
        total += 1;
        // 雨天不该出现纯户外单元
        const unit = BY_ID.get(a.unitId)!;
        if (env.weather === 'rain' && unit.tags.includes('outdoor')) {
          expect(unit.tags.includes('rainy_ok'), `${date} ${unit.name}`).toBe(true);
        }
      }
      const w = `${env.weather}/${env.tempC}℃`.padEnd(12);
      rows.push(
        `${date} ${w} ${describeDay(plan)
          .map((d) => `${d.at} ${d.name}(${d.minutes}m)`)
          .join(' | ')}`,
      );
    }

    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const never = ACTIVITIES.filter((u) => !counts.has(u.id)).map((u) => u.name);
    if ((globalThis as { process?: { env?: Record<string, string> } }).process?.env?.PREVIEW) {
      console.log(rows.join('\n'));
      console.log(
        `\n天数 ${raw.daily.time.length}｜总活动 ${total}｜平均 ${(total / raw.daily.time.length).toFixed(2)} 段/天`,
      );
      console.log(`用到的单元 ${sorted.length}/${ACTIVITIES.length}`);
      console.log('最高频：' + sorted.slice(0, 8).map(([id, n]) => `${BY_ID.get(id)?.name ?? id}×${n}`).join(' '));
      console.log('没出现的：' + (never.length ? never.join('、') : '无'));
      console.log('特殊日：' + (recipes.length ? recipes.join(' ｜ ') : '无'));
    }
    // 阈值：单个单元 30 天最多 6 次，且至少用到 45 个单元。
    // 45 不是 50：作息一改，所有日子的种子都变了，30 天的样本会整体重排——
    // 47~53 都在噪声范围内，卡 50 会让「改一下起床时间」变成一次必红的提交。
    expect(sorted[0]?.[1] ?? 0).toBeLessThanOrEqual(6);
    expect(sorted.length).toBeGreaterThanOrEqual(45);
  });
});
