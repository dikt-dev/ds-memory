/**
 * 聊天提示词里「她自己的生活」这一块：此刻状态 + 当天的社交卡片 + 日记现状。
 *
 * 注意：这里只放**数据**（库里有什么就说什么）。
 * 她认识谁、长什么样、她自己长什么样——那些属于人设，放 persona.md；
 * 代码里不再偷偷注入任何设定，否则人设清空以后她仍然"记得"一堆东西。
 */
import type { Env } from './types';
import { lifePromptLine, residentNowLine } from './life/now-text';
import { loadPersonaDoc, personaSectionText } from './persona-doc';

/** 什么话会触发「她的日记现状」这块。只有存在声明是常驻的。 */
const DIARY_WORDS = /日记|日志|写的东西|写完|那篇|写了吗|写了什么/;

export interface LifeBlocks {
  /** 稳定段：人设文档里写了「人际关系」才带，否则为空 */
  residents: string | null;
  /** 易变段：此刻在干什么 + 今天跟谁混 + 日记现状（每轮都变） */
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

export async function loadLifeBlocks(env: Env, now: Date, userText = ''): Promise<LifeBlocks> {
  const [line, card, personaDoc, diary, homeCity, hisCity] = await Promise.all([
    lifePromptLine(env, now).catch(() => null),
    residentNowLine(env, now).catch(() => null),
    loadPersonaDoc(env).catch(() => ''),
    // 日记现状只在他说到日记时带；平时带"你有日记"那句就够了
    DIARY_WORDS.test(userText) ? diaryAwareness(env).catch(() => null) : Promise.resolve(null),
    env.KV?.get('life:home-city').catch(() => null),
    env.KV?.get('life:user-city').catch(() => null),
  ]);
  const where = [
    `【位置】你在${homeCity || env.CITY || '家'}`,
    hisCity ? `，他在${hisCity}` : '；他在哪你不知道',
    '——两个地方，别对调；他那边天气你不知道，别替他断言。',
  ].join('');
  // 认人要用的长相：每轮都带，不等关键词。
  // 来源只有人设文档——代码里不再有任何写死的人。
  // 段落内的换行直接接上，别用「；」拼——原文里已经有句号了，会变成「。。」
  const flat = (t: string) =>
    t.replace(/\s*\n\s*/g, '').replace(/[。；;，,]\s*$/, '').trim();
  const self = flat(personaSectionText(personaDoc, '外貌'));
  const friends = flat(personaSectionText(personaDoc, '人际'));
  const people = [
    self ? `你自己：${self}。照片或画面里出现这样的人，那就是你，别当成别人。` : '',
    friends ? `你认识的人：${friends}。` : '',
    self || friends
      ? '认人只按上面这些长相来认；照片、视频帧、动图都可能糊，拿不准就说"看着像谁"，别一口咬定。'
      : '',
  ]
    .filter(Boolean)
    .join('\n');
  return {
    residents: people.trim() || null,
    life: [where, line, card, diary].filter(Boolean).join('\n\n') || null,
  };
}
