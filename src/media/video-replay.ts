/**
 * 「再看一眼」：他追问细节时，把同一段视频重看一遍，只回答他问的那个点。
 *
 * 卡片里的过程是一次性的摘要，问得越细越容易答不上来。真人会说"我再看看"，
 * 这里就是同一个动作——同一段视频可以看很多遍，每遍问的角度不同。
 * 只有「他这句话像在追问视频」并且「最近几轮确实发过视频」才触发，避免无谓的等待。
 */
import { signMediaPath } from './signed-url';
import { lookAtVideo } from './video-vision';

const VIDEO_KEY_RE = /\[视频[:：](videos\/[0-9A-Za-z/_.-]+?)\]/;

/** 像不像在追问一段已经看过的视频：再看/仔细/那个字/屏幕/型号/第几秒… */
const ASK_AGAIN_RE =
  /(再看|又看|重看|回看|瞅一眼|瞄一眼|看清楚|看清|放大|仔细|细节|那个字|上面写|屏幕上|型号|牌子|第[0-9一二三四五六七八九十]+秒|刚才那|刚那|那个视频|这视频|里面那个|什么颜色|长什么样)/;

/**
 * 找出该重看的视频 key；不需要重看返回 null。
 *
 * 新的视频消息本身不需要重看——那本来就是第一次看。
 */
export function findReplayKey(
  userText: string,
  recent: { role: string; content: string }[],
): string | null {
  if (!userText || VIDEO_KEY_RE.test(userText)) return null;
  if (!ASK_AGAIN_RE.test(userText)) return null;
  for (let i = recent.length - 1; i >= Math.max(0, recent.length - 8); i -= 1) {
    const hit = VIDEO_KEY_RE.exec(recent[i]?.content ?? '');
    if (hit?.[1]) return hit[1];
  }
  return null;
}

/** 这句话像不像在追问一条已经看过的视频（不区分本地/B 站）。 */
export function wantsReplay(userText: string): boolean {
  return Boolean(userText) && ASK_AGAIN_RE.test(userText) && !VIDEO_KEY_RE.test(userText);
}

const BILI_META_RE = /\[BILI_META\]/;

/** 最近几轮里有没有发过 B 站视频。 */
export function hasRecentBili(recent: { role: string; content: string }[]): boolean {
  for (let i = recent.length - 1; i >= Math.max(0, recent.length - 8); i -= 1) {
    if (BILI_META_RE.test(recent[i]?.content ?? '')) return true;
  }
  return false;
}

/**
 * B 站视频的「再看一眼」。
 *
 * 和本地视频的区别只有一个：地址从 KV 里取。B 站直链是两千多字符的签名地址，
 * 塞进消息里既难看又会被当成资料喂给模型，所以 App 传上来时顺手存一份。
 * 直链约两小时过期，超过就不重看——重新解析要回手机端，服务端拿不到。
 */
export async function replayBili(
  env: { DASHSCOPE_API_KEY?: string; KV: KVNamespace },
  question: string,
): Promise<string | null> {
  if (!env.DASHSCOPE_API_KEY) return null;
  const raw = await env.KV.get('bili:last').catch(() => null);
  if (!raw) return null;
  let rec: { direct?: string; title?: string; cacheKey?: string; duration?: number; at?: number };
  try {
    rec = JSON.parse(raw) as typeof rec;
  } catch {
    return null;
  }
  if (!rec.direct || !rec.at) return null;
  // 直链只有两小时有效期，过期就别拿它去碰壁
  if (Date.now() - rec.at > 2.5 * 3600 * 1000) return null;
  // 长视频重看一次要几十秒，回话前干等太难受：超过 5 分钟就不重看了
  if ((rec.duration ?? 0) > 300) return null;
  const probe = await lookAtVideo(env, rec.direct, {
    cacheKey: `biliq:${rec.cacheKey ?? 'x'}#q:${Math.abs(hash32(question))}`,
    prompt: questionPrompt(question, rec.title),
    maxTokens: 400,
    timeoutMs: 45_000,
  }).catch(() => null);
  const text = probe?.text?.trim();
  return text || null;
}

/** 重看一遍并把答案写成一段文字；任何一步不满足就返回 null（不影响正常回复）。 */
export async function replayVideo(
  env: {
    PUBLIC_BASE_URL?: string;
    AUTH_SECRET?: string;
    DASHSCOPE_API_KEY?: string;
    KV: KVNamespace;
  },
  key: string,
  question: string,
): Promise<string | null> {
  const base = (env.PUBLIC_BASE_URL ?? '').trim().replace(/\/$/, '');
  if (!base || !env.AUTH_SECRET || !env.DASHSCOPE_API_KEY) return null;
  const url = base + (await signMediaPath(env.AUTH_SECRET, key, 900));
  const prompt = questionPrompt(question);
  const obs = await lookAtVideo(env, url, {
    cacheKey: `${key}#q:${Math.abs(hash32(question))}`,
    prompt,
    maxTokens: 400,
  });
  return obs.text.trim() || null;
}

/** 「带着问题重看一遍」的提示词，本地视频和 B 站共用。 */
function questionPrompt(question: string, title?: string): string {
  return [
    '你又在看这段视频，这次是带着问题看的。',
    title ? `【视频标题】${title}` : '',
    `他问：「${question.slice(0, 120)}」`,
    '',
    '只回答他问的那一点，按时间点写清楚看到了什么、上面写了什么字。',
    '问的东西视频里确实没有，就写「没看到」——不要编。',
    '不要总结整段视频，不要评价，不要用「视频展示了」这类套话。',
    '输出纯文本，两三句话。',
  ]
    .filter((line, i) => line || i === 3)
    .join('\n');
}

function hash32(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}
