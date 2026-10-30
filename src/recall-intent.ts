/**
 * 召回选择器（P1-1）：一次调用同时做「想清楚要找什么」和「挑哪几条」。
 *
 * 为什么合成一次：原来召回是「关键词打分 → 再单独调一次 LLM 重排」。拆两步的问题
 * 是打分器不知道自己在找什么——用户说「我们上次聊到哪了」和说「今天好累」，
 * bigram 分不出差别。让模型先写 2~3 个检索意图，再挑条目，挑得准得多。
 *
 * 为什么允许 picks 为空：佐证「宁缺毋滥」——什么都不提，比提错一条更像人。
 *
 * 不记录 query 正文到任何表；只在 trace 里记意图条数与挑选数。
 */
import type { Env } from './types';
import { distillText } from './distill';

/** 选择器超时：超时就用确定性的关键词排序，别让召回卡住。延迟可以接受，放宽到 2.5s。 */
export const SELECT_TIMEOUT_MS = 2500;

export interface RecallCandidate {
  id: string;
  date: string | null;
  content: string;
  section?: string;
}

export interface RecallSelection {
  /** 模型拆出来的检索意图（2~3 条，用于观察与后续多路召回） */
  intents: string[];
  /** 选中的候选 id（按模型给的顺序） */
  pickedIds: string[];
  ms: number;
  backend: string;
}

/**
 * 纯函数：从模型输出里解析出 intents 与 picks 序号。
 * 容错：允许 ```json 代码块、前后多余文字；序号越界丢弃；重复去重。
 */
export function parseSelection(
  text: string,
  candidateCount: number,
  maxPick: number,
): { intents: string[]; picks: number[] } {
  const raw = (text ?? '').trim();
  if (!raw) return { intents: [], picks: [] };

  // 取第一个完整的 {...}（模型偶尔会带解释或代码块）
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return { intents: [], picks: [] };

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return { intents: [], picks: [] };
  }
  if (!parsed || typeof parsed !== 'object') return { intents: [], picks: [] };

  const obj = parsed as { intents?: unknown; picks?: unknown };
  const intents = Array.isArray(obj.intents)
    ? obj.intents
        .filter((x): x is string => typeof x === 'string')
        .map((s) => s.trim())
        .filter((s) => s.length > 0 && s.length <= 40)
        .slice(0, 4)
    : [];

  const picks: number[] = [];
  const pushNumber = (n: number) => {
    if (!Number.isInteger(n)) return;
    if (n < 1 || n > candidateCount) return;
    if (picks.includes(n)) return;
    if (picks.length >= maxPick) return;
    picks.push(n);
  };

  if (Array.isArray(obj.picks)) {
    for (const item of obj.picks) {
      if (typeof item === 'number') pushNumber(item);
      else if (typeof item === 'string') pushNumber(Number(item.trim()));
      else if (item && typeof item === 'object' && 'index' in item) {
        pushNumber(Number((item as { index: unknown }).index));
      }
    }
  }

  return { intents, picks };
}

/**
 * 一次调用完成「意图改写 + 挑选」。
 *
 * 失败（超时 / 网络 / 解析不出来）返回 null，调用方回退到确定性排序。
 */
export async function selectRecall(
  env: Env,
  opts: {
    query: string;
    focus?: string;
    candidates: RecallCandidate[];
    maxPick?: number;
    timeoutMs?: number;
  },
): Promise<RecallSelection | null> {
  const query = (opts.query ?? '').slice(-1000).trim();
  if (!query || opts.candidates.length === 0) return null;

  const maxPick = Math.max(1, opts.maxPick ?? 5);
  const started = performance.now();

  const list = opts.candidates
    .map(
      (c, i) =>
        `${i + 1}. [${c.date ?? '无日期'}]${c.section ? `(${c.section})` : ''} ${c.content.slice(0, 120)}`,
    )
    .join('\n');

  const system = [
    '你在帮一个人回想过去。只做两件事，用 JSON 回答。',
    '第一步 intents：把用户这句话拆成 2~3 个检索意图（他到底想找什么），每条不超过 12 个字。',
    '第二步 picks：从候选里挑出「她此刻真的会想起来、说出来不突兀」的条目序号。',
    '规则：',
    '- 通常只挑 1~3 条。只有用户明确在问「你还记得…」「上次…」时才考虑给满。',
    '- 宁缺毋滥，picks 允许是空数组（用户只是随口说话时，什么都别选）。',
    '- 只靠一个泛词碰上的不要选。',
    '- 稳定事实、正在做的事、共同的第一次，优先。',
    '- 时间很久远的小事要谨慎。',
    '只输出 JSON，例如 {"intents":["学做饭的进展"],"picks":[2,5]}，不要解释。',
  ].join('\n');

  const user = [
    `用户这句话：${query}`,
    opts.focus ? `最近在聊：${(opts.focus ?? '').slice(-300)}` : '',
    `候选（最多选 ${maxPick} 条）：\n${list}`,
  ]
    .filter((l) => l.length > 0)
    .join('\n\n');

  let result: Awaited<ReturnType<typeof distillText>> | null = null;
  try {
    result = await Promise.race([
      distillText(env, system, user, 240, env.SUMMARY_DEEPSEEK_MODEL || env.DEEPSEEK_MODEL),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), opts.timeoutMs ?? SELECT_TIMEOUT_MS)),
    ]);
  } catch (e) {
    console.warn('[recall-intent] select failed:', e);
    return null;
  }
  if (!result) return null;

  const { intents, picks } = parseSelection(result.text, opts.candidates.length, maxPick);
  const pickedIds = picks.map((n) => opts.candidates[n - 1]?.id).filter((id): id is string => Boolean(id));

  return {
    intents,
    pickedIds,
    ms: Math.round(performance.now() - started),
    backend: result.backend,
  };
}
