/**
 * 聊天提示词里「她自己的生活」这一块：名录 + 此刻状态 + 当天住户卡片。
 *
 * 以前这段在 chat.ts 和 openai.ts 各写一遍，住户上线时只改了 chat.ts，
 * 结果线上（走 openai.ts）完全没生效。现在只有这一个来源。
 */
import type { Env } from './types';
import { lifePromptLine, residentNowLine } from './life/now-text';
import { SELF, residentLooksRoster, residentRoster } from './life/residents';
import { resolvePersona } from './persona';
import { loadPersonaDoc, personaSectionText } from './persona-doc';

export interface LifeBlocks {
  /** 稳定段：公寓名录（每天不变，能命中前缀缓存） */
  residents: string | null;
  /** 易变段：此刻在干什么 + 今天跟谁混（每轮都变） */
  life: string | null;
}

/**
 * 日记现状：写过几篇、最近一篇是哪天、大概写了什么。
 *
 * 只有「存在」的话她会说"我写过日记"，被问到内容还是编；
 * 带上现状才能"记得大概、不记得细节"——真人就是这样。
 */
async function diaryAwareness(env: Env): Promise<string | null> {
  const rows = await env.DB.prepare(
    `SELECT date_key, summary FROM ai_diary ORDER BY date_key DESC LIMIT 3`,
  ).all<{ date_key: string; summary: string | null }>();
  const list = rows.results ?? [];
  if (list.length === 0) return null;
  const dates = list.map((r) => r.date_key.slice(5)).join('、');
  const latest = (list[0].summary ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
  return [
    '【你的日记】',
    `- 至今写过 ${list.length} 篇（最近的：${dates}）。`,
    latest ? `- 最近一篇大概写的是：${latest}` : '- 最近一篇的内容你想不太清了。',
    '- 他问起可以说个大概；没带全文的时候别复述细节，说"想不起具体写了啥，要看吗"。',
  ].join('\n');
}

export async function loadLifeBlocks(env: Env, now: Date): Promise<LifeBlocks> {
  const [line, card, personaDoc, diary] = await Promise.all([
    lifePromptLine(env, now).catch(() => null),
    residentNowLine(env, now).catch(() => null),
    loadPersonaDoc(env).catch(() => ''),
    diaryAwareness(env).catch(() => null),
  ]);
  // 长相：persona.md 的「外貌」卡 → 代码里的她的档案 → 环境变量。
  // SELF.looks 一直存在，却从没进过提示词——所以照片里她从来认不出自己。
  const look = personaSectionText(personaDoc, '外貌') || SELF.looks || resolvePersona(env).look;
  return {
    // 名录 + 长相：名字解决「谁住这儿」，长相解决「照片里这个是谁」。
    // 自己的长相放在最前面——先认出「这是我」，再谈别人。
    residents:
      [
        (() => {
          const flat = look.replace(/\s*\n\s*/g, '；').trim();
          return flat ? `你自己：${flat}。照片或画面里出现这样的人，那就是你，别当成别人。` : '';
        })(),
        '认人只按上面这些长相描述来认；照片、视频帧、动图都可能糊，拿不准就说"看着像谁"，别一口咬定。',
        residentRoster(),
        residentLooksRoster(),
      ]
        .filter(Boolean)
        .join('\n\n') || null,
    life: [line, card, diary].filter(Boolean).join('\n\n') || null,
  };
}
