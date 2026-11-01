import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { ACTIVITIES } from './pool';
import { buildDay } from './planner';
import { weatherFromCode } from './weather';

/**
 * 池子里每一条单元都必须有可能被排出来。
 *
 * 为什么需要这个测试：`starts` 写错一种边界（比如 [[20*60, 24*60]] 里的 1440），
 * ruleOk 就恒假，单元会**无声无息地消失**——不报错、日志没有、日程也照样合法。
 * 「收拾屋子」就这么消失了很久，直到有人发现夜里少了一项。
 *
 * 规则层的错要靠「能不能排出来」来发现，不能靠「排出来合不合法」。
 */

/** 条件受限的单元：样本里没有对应条件，不算 bug。 */
const CONDITIONAL: Record<string, string> = {
  anime_marathon: '要周末 + 夜间窗口 + 14 天冷却',
  snow_watch: '要下雪，fixture 里没有雪天',
  fest_chongyang: '要 2028 重阳，fixture 是 2025 年',
};

describe('池子可达性', () => {
  it('每条单元都能被排出来（除条件受限的）', () => {
    const raw = JSON.parse(readFileSync('src/life/fixtures/weather60.json', 'utf8')) as {
      daily: { time: string[]; weather_code: number[]; temperature_2m_max: number[] };
    };
    const seen = new Set<string>();
    for (let i = 0; i < raw.daily.time.length; i += 1) {
      const env = {
        weather: weatherFromCode(raw.daily.weather_code[i]),
        tempC: Math.round(raw.daily.temperature_2m_max[i]),
        atHome: true,
      };
      // 多个 salt：同一天的随机分支要尽可能铺开，不然会误判成「排不出来」
      for (let s = 0; s < 8; s += 1) {
        for (const a of buildDay({ date: raw.daily.time[i], env, salt: `s${s}` }).activities) {
          seen.add(a.unitId);
        }
      }
    }
    const missing = ACTIVITIES.filter((u) => !seen.has(u.id)).map((u) => u.id);
    const unexpected = missing.filter((id) => !(id in CONDITIONAL));
    expect(unexpected, `这些单元一次都排不出来（规则写死了？）：${unexpected.join(', ')}`).toEqual([]);
  });
});
