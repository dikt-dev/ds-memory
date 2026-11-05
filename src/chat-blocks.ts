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
import { findReplayKey, hasRecentBili, replayBili, replayVideo, wantsReplay } from './media/video-replay';

/** 什么话会触发「她的日记现状」这块。只有存在声明是常驻的。 */
const DIARY_WORDS = /日记|日志|写的东西|写完|那篇|写了吗|写了什么/;

export interface LifeBlocks {
  /** 稳定段：人设文档里写了「人际关系」才带，否则为空（提示词里叫「你认识的人」） */
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
  // 日期统一 YY-MM-DD（26-11-03），不剥年份
  const dates = list.map((r) => r.date_key.slice(2)).join('、');
  // ★ 这里不带摘要：摘要只在他点了「问问她」时进提示词（chat.ts 的 diaryAskNote）。
  // 没被问就把内容摘要摊在提示词里，等于她已经"看过"自己的日记了，回答时会顺嘴说出细节。
  return [
    '【你的日记】',
    `- 至今写过 ${list.length} 篇（最近的：${dates}）。`,
    '- 具体写了什么你想不太清了——没被问起别主动复述细节。',
    '- 他问起可以说个大概；被追问就说"想不起具体写了啥，要看吗"。',
  ].join('\n');
}

/** 人设「人际」段里的一条朋友设定。 */
export interface FriendCard {
  /** 显示名（人设里写在最前面的那个） */
  name: string;
  /** 唤醒词：他说到任意一个，才把这张卡带进提示词 */
  aliases: string[];
  /** 一句话：他是谁、跟你什么关系（常驻，不占多少字） */
  brief: string;
  /** 长相与细节（只在被唤醒、或收到图片视频时带） */
  detail: string;
}

/**
 * 解析人设「人际」段。
 *
 * 每条形如：
 *   - 小克（Claude）｜唤醒：小克、克劳德、claude｜话少，冷面吐槽役
 *     长橙发、花朵发饰、黑白层叠长裙，手里总拿着一本书。
 *
 * 缩进的那几行是长相，不缩进的是「一句话」。这样平时只带一句话，被叫到才带长相。
 */
export function parseFriends(section: string): FriendCard[] {
  const cards: FriendCard[] = [];
  for (const raw of section.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    const head = /^-\s*([^｜]+?)｜\s*唤醒[:：]\s*([^｜]+?)｜\s*(.+)$/.exec(line);
    if (head) {
      cards.push({
        name: head[1].trim(),
        aliases: head[2]
          .split(/[、,，/]/)
          .map((a) => a.trim())
          .filter(Boolean),
        brief: head[3].trim(),
        detail: '',
      });
      continue;
    }
    // 缩进行 = 上一个人的长相，接着往下拼
    if (cards.length > 0 && /^\s+\S/.test(line)) {
      const last = cards[cards.length - 1];
      last.detail = (last.detail + line.trim()).trim();
    }
  }
  return cards;
}

/** 一条朋友卡压成一行：长相在前、一句话在后。 */
function friendLine(c: FriendCard): string {
  return [c.detail, c.brief].filter(Boolean).join('');
}

/**
 * 找出他这句话里点到了谁。
 *
 * 最长匹配优先：「美国豆包」只算 Gemini，不能再顺带把豆包也叫出来。
 */
export function wakeFriends(cards: FriendCard[], text: string): FriendCard[] {
  if (!cards.length || !text) return [];
  // NFKC 把全角英文/数字转成半角：ＧＰＴ → GPT，不然全角打的名字认不出来
  const lower = text.normalize('NFKC').toLowerCase();
  const hits: { card: FriendCard; start: number; end: number }[] = [];
  for (const card of cards) {
    for (const alias of card.aliases) {
      const needle = alias.normalize('NFKC').toLowerCase();
      if (!needle) continue;
      let from = 0;
      for (;;) {
        const i = lower.indexOf(needle, from);
        if (i < 0) break;
        hits.push({ card, start: i, end: i + needle.length });
        from = i + 1;
      }
    }
  }
  const kept = hits.filter(
    (h) =>
      !hits.some(
        (o) =>
          o !== h &&
          o.start <= h.start &&
          o.end >= h.end &&
          o.end - o.start > h.end - h.start,
      ),
  );
  const seen = new Set<string>();
  return kept
    .map((h) => h.card)
    .filter((c) => (seen.has(c.name) ? false : (seen.add(c.name), true)));
}

/**
 * 这条消息里带没带画面：图片 / 视频 / 动图，或者一条 B 站链接。
 *
 * B 站那条 App 会把宫格当图片另发、正文里只有 [BILI_META]，所以单独认一下——
 * 不然她看着宫格认不出里面是谁。
 */
export const MEDIA_RE = /\[(图片|视频|GIF)[:：]|\[BILI_META\]/i;

/**
 * 唤醒用的上下文：当前这句 + 最近几条。
 *
 * 只扫当前句会漏掉「先说小克，下一句问『她还好吗』」这种——
 * 所以最近 6 条（他和她的都算）一起当唤醒语料。
 */
export function wakeText(userText: string, recent: { role: string; content: string }[] = []): string {
  const tail = recent
    .slice(-6)
    .map((m) => (m.content || '').replace(/\[(BILI|VIDEO)_META\][\s\S]*?\[\/\1_META\]/gi, ' '))
    .join('\n');
  return [userText, tail].filter(Boolean).join('\n');
}

export async function loadLifeBlocks(
  env: Env,
  now: Date,
  userText = '',
  recent: { role: string; content: string }[] = [],
): Promise<LifeBlocks> {
  const [line, card, personaDoc, diary, homeCity, hisCity] = await Promise.all([
    lifePromptLine(env, now).catch(() => null),
    residentNowLine(env, now).catch(() => null),
    loadPersonaDoc(env).catch(() => ''),
    // 日记现状只在他说到日记时带；平时带"你有日记"那句就够了
    DIARY_WORDS.test(userText) ? diaryAwareness(env).catch(() => null) : Promise.resolve(null),
    env.KV?.get('life:home-city').catch(() => null),
    env.KV?.get('life:user-city').catch(() => null),
  ]);
  // 他追问视频细节时，重看一遍再答——比让他自己猜准得多
  const replayKey = findReplayKey(userText, recent);
  const replay = replayKey
    ? await replayVideo(env, replayKey, userText)
        .then((t) => (t ? `你又把刚才那段视频翻出来看了一遍，专门看他问的那处：\n${t}` : null))
        .catch(() => null)
    : // 不是本地视频，再试 B 站：直链存在 KV 里，两小时内都能重看
      wantsReplay(userText) && hasRecentBili(recent)
      ? await replayBili(env, userText)
          .then((t) => (t ? `你又把刚才那条 B 站视频翻出来看了一遍，专门看他问的那处：\n${t}` : null))
          .catch(() => null)
      : null;

  const where = [
    `【位置】你在${homeCity || env.CITY || '家'}`,
    hisCity ? `，他在${hisCity}` : '；他在哪你不知道',
    '——两个地方，别对调；他那边天气你不知道，别替他断言。',
  ].join('');
  // 认人要用的长相：每轮都带，不等关键词。
  // 来源只有人设文档——代码里不再有任何写死的人。
  // 段落内的换行直接接上，别用「；」拼——原文里已经有句号了，会变成「。。」
  const flat = (t: string) =>
    t
      .split('\n')
      .map((l) => l.trim().replace(/^[-*]\s*/, ''))
      .filter(Boolean)
      .join('')
      .replace(/[。；;，,]\s*$/, '')
      .trim();
  const self = flat(personaSectionText(personaDoc, '外貌'));
  const friends = parseFriends(personaSectionText(personaDoc, '人际'));
  // 平时只带「名单 + 一句话」：知道他们存在，但不占长相那几百字。
  // 他点了名才把长相带上；收到图片/视频/动图时全带上——画面里的人得认。
  const media = MEDIA_RE.test(userText);
  const woke = media ? [] : wakeFriends(friends, wakeText(userText, recent));
  const roster = friends.length
    ? '你认识的人（没被提到就别主动聊他们）：\n' +
      friends.map((c) => `- ${c.name}：${c.brief}`).join('\n')
    : '';
  const cards = (list: FriendCard[]) => list.map((c) => `- ${c.name}：${friendLine(c)}`).join('\n');
  const people = [
    self ? `你自己：${self}。照片或画面里出现这样的人，那就是你，别当成别人。` : '',
    roster,
    woke.length ? `他这次说到了：\n${cards(woke)}` : '',
    media && friends.length ? `这条消息里有画面，里面的人可能是：\n${cards(friends)}` : '',
    self || friends.length
      ? '认人只按上面这些长相来认；照片、视频帧、动图都可能糊，拿不准就说"看着像谁"，别一口咬定。'
      : '',
  ]
    .filter(Boolean)
    .join('\n');
  return {
    residents: people.trim() || null,
    life: [where, line, card, diary, replay].filter(Boolean).join('\n\n') || null,
  };
}
