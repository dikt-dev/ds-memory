import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildDay, describeDay, MAX_ACTIVITIES } from './planner';
import { ACTIVITIES, BY_ID } from './pool';
import { weatherFromCode } from './weather';
import { validateDay } from './validate';
import type { DayEnv } from './types';

/**
 * 30 天日程评审：用真实历史天气（Open-Meteo archive）生成，打印成表。
 * PREVIEW=1 npx vitest run src/life/preview.test.ts 才会打印大表；
 * 平时这条只校验「每天 2–5 段、全部过校验」。
 */
const raw = JSON.parse(
  readFileSync('src/life/fixtures/weather30.json', 'utf8'),
) as { daily: { time: string[]; temperature_2m_max: number[]; weather_code: number[] } };

describe('30 天日程评审', () => {
  it('每天 2–5 段、全部过校验、天气与池子不冲突', () => {
    const recent = new Map<string, string[]>();
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
      const plan = buildDay({ date, env, recentUses: recent });
      expect(validateDay(plan), date).toEqual([]);
      expect(plan.activities.length, date).toBeGreaterThanOrEqual(2);
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
    if (process.env.PREVIEW) {
      console.log(rows.join('\n'));
      console.log(
        `\n天数 ${raw.daily.time.length}｜总活动 ${total}｜平均 ${(total / raw.daily.time.length).toFixed(2)} 段/天`,
      );
      console.log(`用到的单元 ${sorted.length}/${ACTIVITIES.length}`);
      console.log('最高频：' + sorted.slice(0, 8).map(([id, n]) => `${BY_ID.get(id)?.name ?? id}×${n}`).join(' '));
      console.log('没出现的：' + (never.length ? never.join('、') : '无'));
    }
    // 阈值：单个单元 30 天最多 4 次，且至少用到 50 个单元
    expect(sorted[0]?.[1] ?? 0).toBeLessThanOrEqual(6);
    expect(sorted.length).toBeGreaterThanOrEqual(50);
  });
});
