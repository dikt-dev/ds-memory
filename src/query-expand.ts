/**
 * 模糊指代消解："那个项目""上次那个视频" 到底指什么。
 *
 * 为什么需要（2026-11-08 探针）：用户说「你那个项目」，向量/关键词召回拿到的是
 * 一堆含"项目"的条目，但指代不到具体那件事；实体表是完整解法，这里先做最小可用版：
 *
 * 1. 认出模糊指代（那个/这个/上次的/之前的 + 名词）；
 * 2. 在记忆文本里找最近的、含该名词的条目；
 * 3. 把那一条的关键词并进召回查询，让召回"知道指的是哪件事"。
 */
import type { Env } from './types';
import { getMemory } from './memory';

/** 常见的可指代名词。命中其一才做消解，避免每句都去扫记忆。 */
export const REFERENT_NOUNS = [
  '项目', '视频', '片子', '电影', '番', '歌', '游戏', '奶茶', '外卖',
  '礼物', '约定', '事情', '那件事', '那个人', '那个地方', '店',
];

const VAGUE = /(那个|这个|上次|之前|上回|刚才说的|前面说的)/;

export interface ExpandedQuery {
  query: string;
  /** 命中并展开时给出指代到的条目，便于排查 */
  resolved?: string[];
}

/** 从一句话里抽出「模糊指代 + 名词」。 */
export function vagueReferents(text: string): string[] {
  if (!VAGUE.test(text)) return [];
  const out: string[] = [];
  for (const noun of REFERENT_NOUNS) {
    if (text.includes(noun)) out.push(noun);
  }
  // 「那个视频」这种没命中名词表时，抓「那个 + 两三个字」
  if (out.length === 0) {
    const m = text.match(/(那个|这个|上次的?|之前的?)([\u4e00-\u9fa5]{1,4})/);
    if (m) out.push(m[2]);
  }
  return out.slice(0, 2);
}

/**
 * 把模糊指代展开成具体线索：在记忆里找最近含该名词的条目，取其关键词并进查询。
 * 读不到记忆就原样返回（这条链路失败不能拖慢聊天）。
 */
export async function expandVagueQuery(
  env: Env,
  userText: string,
  baseQuery: string,
): Promise<ExpandedQuery> {
  const nouns = vagueReferents(userText);
  if (nouns.length === 0) return { query: baseQuery };

  const memory = await getMemory(env).catch(() => '');
  if (!memory) return { query: baseQuery };

  const lines = memory.split('\n').filter((l) => l.trim().startsWith('- '));
  const resolved: string[] = [];
  const extra: string[] = [];
  for (const noun of nouns) {
    const hit = [...lines].reverse().find((l) => l.includes(noun));
    if (!hit) continue;
    const body = hit.replace(/^\s*-\s*/, '').replace(/^\[[^\]]*\]\s*/, '').slice(0, 80);
    resolved.push(body);
    // 取该条目里的实词，补进查询（去重后最多 6 个）
    for (const w of body.match(/[\u4e00-\u9fa5]{2,6}/g) ?? []) {
      if (w !== noun && !extra.includes(w)) extra.push(w);
      if (extra.length >= 6) break;
    }
  }
  if (extra.length === 0) return { query: baseQuery, resolved };
  return { query: `${baseQuery} ${extra.join(' ')}`, resolved };
}
