import { describe, expect, it } from 'vitest';
import { ACTIVITIES, BY_ID } from './pool';
import { SLEEP_START, WAKE_AT, antiRepeatWeight, buildDay, dayWindows, tagsOk } from './planner';
import { validateDay } from './validate';
import {
  applyConsent,
  classifyConsent,
  decideShare,
  diaryForClient,
  makeDiaryEntry,
  markAsked,
  parseDiaryOutput,
} from './diary';
import { hashSeed, makeRng } from './seed';

const env = { weather: 'sunny', tempC: 22, atHome: true };

/** 真日期推进（不能拿同一天循环，那样等于只测一天）。 */
function dayAfter(start: string, n: number): string {
  const d = new Date(start + 'T00:00:00+08:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}
const input = (date: string, salt = '') => ({ date, env, salt });

describe('池子', () => {
  it('64 条，id 不重复，时长区间合法', () => {
    expect(ACTIVITIES.length).toBe(64);
    expect(new Set(ACTIVITIES.map((u) => u.id)).size).toBe(64);
    for (const u of ACTIVITIES) {
      expect(u.min).toBeGreaterThan(0);
      expect(u.max).toBeGreaterThanOrEqual(u.min);
      expect(u.replyChance).toBeGreaterThanOrEqual(0);
      expect(u.replyChance).toBeLessThanOrEqual(1);
    }
  });

  it('雨天只出带 rainy_ok 的出门项', () => {
    const rainy = { weather: 'rain', tempC: 18, atHome: true };
    for (const u of ACTIVITIES) {
      if (!u.tags.includes('outdoor')) continue;
      if (u.tags.includes('rainy_ok')) continue;
      expect(tagsOk(u, rainy), u.id).toBe(false);
    }
  });

  it('不在家时不能选纯室内单元', () => {
    const away = { weather: 'sunny', tempC: 22, atHome: false };
    expect(tagsOk(BY_ID.get('anime_series')!, away)).toBe(false);
    expect(tagsOk(BY_ID.get('outing_cafe')!, away)).toBe(true);
  });
});

describe('生成', () => {
  it('同一天同盐一定给出同一份计划', () => {
    const a = buildDay(input('2026-11-01'));
    const b = buildDay(input('2026-11-01'));
    expect(a).toEqual(b);
  });

  it('换盐会重抽', () => {
    const a = buildDay(input('2026-11-01', 'a'));
    const b = buildDay(input('2026-11-01', 'b'));
    expect(a.activities).not.toEqual(b.activities);
  });

  it('活动都在空档里、不重叠', () => {
    const plan = buildDay(input('2026-11-02'));
    const windows = dayWindows();
    for (const act of plan.activities) {
      expect(windows.some((w) => act.start >= w.start && act.end <= w.end), JSON.stringify(act)).toBe(true);
    }
    for (let i = 1; i < plan.activities.length; i += 1) {
      expect(plan.activities[i].start).toBeGreaterThanOrEqual(plan.activities[i - 1].end);
    }
  });

  it('连续 30 天都过校验（雨天/晴冷/在家/在外都跑）', () => {
    for (let d = 0; d < 30; d += 1) {
      const date = dayAfter('2026-11-01', d);
      const variants = [
        env,
        { weather: 'rain', tempC: 16, atHome: true },
        { weather: 'snow', tempC: 2, atHome: true },
        { weather: 'sunny', tempC: 34, atHome: true },
        { weather: 'sunny', tempC: 24, atHome: false },
      ];
      for (const e of variants) {
        const plan = buildDay({ date, env: e, salt: String(d) });
        const issues = validateDay(plan);
        expect(issues, `${date} ${JSON.stringify(e)}: ${JSON.stringify(issues)}`).toEqual([]);
      }
    }
  });

  it('120 天里池子基本没有死条（天气轮着来）', () => {
    const seen = new Set<string>();
    const weathers = [
      { weather: 'sunny', tempC: 22, atHome: true },
      { weather: 'rain', tempC: 17, atHome: true },
      { weather: 'snow', tempC: 3, atHome: true },
      { weather: 'sunny', tempC: 33, atHome: true },
      { weather: 'cloudy', tempC: 12, atHome: true },
    ];
    for (let d = 0; d < 120; d += 1) {
      const date = dayAfter('2027-01-01', d);
      for (const a of buildDay({ date, env: weathers[d % weathers.length], salt: String(d) }).activities) {
        seen.add(a.unitId);
      }
    }
    const unused = ACTIVITIES.filter((u) => !seen.has(u.id)).map((u) => u.id);
    // 允许几条极端稀有的长期不在家/极端天气单元，但绝大多数必须被用到
    expect(unused.length, JSON.stringify(unused)).toBeLessThanOrEqual(4);
  });

  it('反重复：3 天内用过降到 0.35，14 天内三次禁用', () => {
    const uses = new Map([['draw', ['2026-10-30', '2026-10-25', '2026-10-20']]]);
    expect(antiRepeatWeight('draw', '2026-11-01', uses)).toBe(0);
    const twice = new Map([['draw', ['2026-10-30', '2026-10-28']]]);
    expect(antiRepeatWeight('draw', '2026-11-01', twice)).toBe(0.15);
    const once = new Map([['draw', ['2026-10-30']]]);
    expect(antiRepeatWeight('draw', '2026-11-01', once)).toBe(0.35);
    const old = new Map([['draw', ['2026-10-01']]]);
    expect(antiRepeatWeight('draw', '2026-11-01', old)).toBe(1);
  });
});

describe('随机', () => {
  it('同种子同序列', () => {
    const a = makeRng('x');
    const b = makeRng('x');
    for (let i = 0; i < 20; i += 1) expect(a.next()).toBe(b.next());
  });
  it('种子分布不像粘住', () => {
    const values = new Set<number>();
    for (let i = 0; i < 50; i += 1) values.add(hashSeed('2026-11-' + i));
    expect(values.size).toBe(50);
  });
});

describe('日记', () => {
  it('解析 JSON / 纯文本 / 坏 JSON', () => {
    expect(parseDiaryOutput('{"text":"今天追番","share":true,"reason":"挺开心"}')).toEqual({
      text: '今天追番',
      share: true,
      reason: '挺开心',
    });
    expect(parseDiaryOutput('今天什么都没干').share).toBe(false);
    // 模型常见的两种坏格式：JSON 转义过 / 忘了转义
    const escaped = parseDiaryOutput('今天追了番，挺开心。{\\"share\\": false, \\"reason\\": \\"有点累\\"}');
    expect(escaped.share).toBe(false);
    expect(escaped.text).toBe('今天追了番，挺开心。');
    const trailing = parseDiaryOutput('今天没什么事。{"share": true, "reason": "普通的一天"}');
    expect(trailing.share).toBe(true);
    expect(trailing.text).toBe('今天没什么事。');
    expect(trailing.reason).toBe('普通的一天');
  });

  it('不同意的一律私密', () => {
    const entry = makeDiaryEntry({
      dateKey: '2026-11-01',
      draft: { text: '他惹我生气了', share: false },
      mood: -0.3,
      location: '家',
    });
    expect(entry.visibility).toBe('private');
    expect(diaryForClient(entry).text).toBeUndefined();
  });

  it('模型说分享，但内容是委屈 → 压回私密', () => {
    const draft = decideShare({ text: '今天他惹我生气，不想理他', share: true });
    expect(draft.share).toBe(false);
  });

  it('同意判定：明确同意才算', () => {
    expect(classifyConsent('行吧')).toBe('yes');
    expect(classifyConsent('给你看')).toBe('yes');
    expect(classifyConsent('拿去')).toBe('yes');
    expect(classifyConsent('凭什么')).toBe('no');
    expect(classifyConsent('你自己不会想吗')).toBe('no');
    expect(classifyConsent('这篇不想给')).toBe('no');
    expect(classifyConsent('嗯')).toBe('unclear');
  });

  it('问了 → pending，答应才 shared，拒绝仍是 private', () => {
    const base = makeDiaryEntry({
      dateKey: '2026-11-02',
      draft: { text: '今天去逛街了', share: false },
      mood: 0.4,
      location: '家',
    });
    expect(markAsked(base).visibility).toBe('pending');
    expect(diaryForClient(markAsked(base)).visible).toBe(false);
    const yes = applyConsent(base, '行吧');
    expect(yes.visibility).toBe('shared');
    expect(diaryForClient(yes).text).toBe('今天去逛街了');
    expect(applyConsent(base, '想得美').visibility).toBe('private');
  });
});
