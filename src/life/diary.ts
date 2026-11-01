/**
 * 日记（§10）。
 *
 * 三条设计是硬的，代码必须挡住：
 *   1. 默认私密——生成时她自己判 share，默认 false
 *   2. 同意必须明确——「行 / 看吧 / 给你看」算同意；「你自己不会想吗」这类反问算拒绝
 *   3. 不可见时正文**不出服务端**——不是前端藏一下
 *
 * 所以这个模块不产出「能不能看」的布尔值就完事，它还要管
 * 「问了但没答」「被拒了」这两种中间态，因为拒绝是真实有效的。
 */
import type { Rng } from './seed';

export type DiaryVisibility = 'private' | 'shared' | 'pending';

export interface DiaryEntry {
  dateKey: string;
  text: string;
  mood: number;
  location: string;
  visibility: DiaryVisibility;
  /** 她当时为什么愿意/不愿意 */
  shareReason?: string;
  /** 你在聊天里问到、她同意的时间 */
  sharedAt?: string;
  createdAt: string;
}

export interface DiaryDraft {
  text: string;
  share: boolean;
  reason?: string;
}

/**
 * 从模型输出里解析日记。
 *
 * 模型可能给 JSON、可能给「JSON 包在文字里」、也可能只给一段正文。
 * 三种都要能收：拿不到结构化字段时按「不愿分享」处理——宁可保守。
 */
export function parseDiaryOutput(raw: string): DiaryDraft {
  const text = (raw ?? '').trim();
  if (!text) return { text: '', share: false, reason: '生成失败' };

  // 模型经常把 JSON 写成转义过的 {"share": true}，也可能忘了转义。
  // 先按「最后一段花括号」把它切出来，两种写法都试一次。
  const body = text.replace(/\\"/g, '"');
  const start = body.lastIndexOf('{');
  const end = body.lastIndexOf('}');
  let shareBlock = '';
  let journal = body;
  if (start >= 0 && end > start) {
    shareBlock = body.slice(start, end + 1);
    journal = body.slice(0, start).trim();
  }

  let share = false;
  let reason: string | undefined;
  if (shareBlock) {
    try {
      const parsed = JSON.parse(shareBlock) as { text?: unknown; share?: unknown; reason?: unknown };
      // 整篇就是 JSON 的情况（{"text": "...", "share": ...}）
      if (typeof parsed.text === 'string' && parsed.text.trim()) {
        return {
          text: parsed.text.trim(),
          share: parsed.share === true,
          reason: typeof parsed.reason === 'string' ? parsed.reason : undefined,
        };
      }
      share = parsed.share === true;
      reason = typeof parsed.reason === 'string' ? parsed.reason : undefined;
    } catch {
      // JSON 坏了也别把整篇丢掉：正则捞一下 share
      const m = shareBlock.match(/"share"\s*:\s*(true|false)/);
      share = m?.[1] === 'true';
      const r = shareBlock.match(/"reason"\s*:\s*"([^"]*)"/);
      reason = r?.[1];
    }
  }

  // 正文是空的时候（模型只给了 JSON）才退回整段，免得把 JSON 当日记存起来
  const finalText = journal || (shareBlock ? '' : text);
  if (!finalText) return { text: '', share: false, reason: '只有 JSON，没有正文' };
  return { text: finalText, share, reason: reason ?? (shareBlock ? undefined : '没给出是否愿意分享') };
}

/** 内容倾向 → 愿分享的先验概率（§10.3 的参考分布）。 */
const SHARE_PRIOR: Array<{ test: RegExp; p: number }> = [
  { test: /讨厌|生气|委屈|吃醋|不想理|烦死/, p: 0.25 },
  { test: /我是什么|算不算|是不是真的|存在/, p: 0.1 },
  { test: /哄|记得|夸|陪我|谢谢/, p: 0.75 },
];

export function sharePrior(text: string): number {
  for (const rule of SHARE_PRIOR) if (rule.test.test(text)) return rule.p;
  return 0.85;
}

/**
 * 模型的判断 + 先验校准。
 *
 * 模型说 share=true 但内容明显是委屈/自我怀疑时，压回私密——
 * 这是防止「自我暴露」被模型随手送出去。反过来不放开：
 * 模型说不想给，就是不想给。
 */
export function decideShare(draft: DiaryDraft, rng?: Rng): DiaryDraft {
  if (!draft.share) return draft;
  const prior = sharePrior(draft.text);
  if (prior >= 0.5) return draft;
  const keep = rng ? rng.chance(prior) : false;
  return keep ? draft : { ...draft, share: false, reason: draft.reason ?? '这篇写着写着有点不想给看' };
}

export type ConsentVerdict = 'yes' | 'no' | 'unclear';

/** 明确的同意词。只有这些算同意。 */
const YES = /(看吧|给你看|拿去|行吧|可以看|给你|看你看|拿去吧|好吧)/;
/** 明确/反问式拒绝。「你自己不会想吗」「凭什么」一律按拒绝。 */
const NO = /(不给|不想给|凭什么|想得美|没门|休想|自己不会想|不告诉|别看|不要看|不让你看|不要|不行|没得商量|算了|不必)/;
const QUESTION = /[？?]/;

/**
 * 判断她在聊天里的回应算不算同意。
 *
 * 规则来自实际决定：「你自己不会想吗」这类反问**算拒绝**，不当作默许。
 */
export function classifyConsent(reply: string): ConsentVerdict {
  const text = (reply ?? '').trim();
  if (!text) return 'unclear';
  if (NO.test(text)) return 'no';
  if (YES.test(text)) return 'yes';
  if (QUESTION.test(text)) return 'no'; // 反问 = 拒绝，不是默许
  return 'unclear';
}

/** 生成一条日记记录。默认私密。 */
export function makeDiaryEntry(input: {
  dateKey: string;
  draft: DiaryDraft;
  mood: number;
  location: string;
  now?: Date;
}): DiaryEntry {
  const now = input.now ?? new Date();
  return {
    dateKey: input.dateKey,
    text: input.draft.text,
    mood: input.mood,
    location: input.location,
    visibility: input.draft.share ? 'shared' : 'private',
    shareReason: input.draft.reason,
    createdAt: now.toISOString(),
  };
}

/**
 * 用户点「问问她」之后落状态：pending。
 *
 * 注意不是「等审批」——请求要走进聊天，她怎么回由 classifyConsent 判。
 */
export function markAsked(entry: DiaryEntry): DiaryEntry {
  if (entry.visibility === 'shared') return entry;
  return { ...entry, visibility: 'pending' };
}

/** 她的回应落库。yes 才变 shared，no 就停在 private 并记下理由。 */
export function applyConsent(entry: DiaryEntry, reply: string, now = new Date()): DiaryEntry {
  const verdict = classifyConsent(reply);
  if (verdict === 'yes') {
    return { ...entry, visibility: 'shared', sharedAt: now.toISOString(), shareReason: reply.slice(0, 60) };
  }
  if (verdict === 'no') {
    return { ...entry, visibility: 'private', shareReason: reply.slice(0, 60) };
  }
  return entry;
}

/** 接口出口：不可见时**不带正文**。 */
export function diaryForClient(entry: DiaryEntry | null): {
  date: string;
  visible: boolean;
  text?: string;
  reason?: string;
} {
  if (!entry) return { date: '', visible: false };
  if (entry.visibility !== 'shared') {
    return { date: entry.dateKey, visible: false, reason: '这篇她还没说要不要给你看' };
  }
  return { date: entry.dateKey, visible: true, text: entry.text };
}
