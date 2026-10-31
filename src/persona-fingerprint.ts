/**
 * 人格指纹（ADR-001 S11）。
 *
 * 只改记忆也能改性格：她记住的全是争执，语气就会变硬。
 * 所以除了看"她记不记得"，还要看"她还是不是她"。
 *
 * 指纹 = 一组可量化的语气特征（句长、语气词密度、称呼密度、情绪词密度），
 * 用近 7 天 vs 前 7 天做同比；偏差超阈值就报警（可选自动回滚到上一版快照）。
 */
import type { Env } from './types';

export interface Fingerprint {
  messages: number;
  avgChars: number;
  particlesPerMsg: number;
  addressPerMsg: number;
  emojiPerMsg: number;
}

export interface FingerprintComparison {
  current: Fingerprint;
  previous: Fingerprint;
  drift: number;
  drifted: boolean;
  reasons: string[];
}

const PARTICLES = /[呀嘛呢吧哦啦嗨欸诶]/g;
const ADDRESS = /(本小姐|笨蛋|大人|小蓝)/g;
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu;
const DRIFT_THRESHOLD = 0.25;

export function buildFingerprint(texts: string[]): Fingerprint {
  const messages = texts.length;
  if (messages === 0) {
    return { messages: 0, avgChars: 0, particlesPerMsg: 0, addressPerMsg: 0, emojiPerMsg: 0 };
  }
  let chars = 0;
  let particles = 0;
  let address = 0;
  let emoji = 0;
  for (const raw of texts) {
    const text = raw ?? '';
    chars += text.length;
    particles += (text.match(PARTICLES) ?? []).length;
    address += (text.match(ADDRESS) ?? []).length;
    emoji += (text.match(EMOJI) ?? []).length;
  }
  const round = (v: number) => Math.round(v * 1000) / 1000;
  return {
    messages,
    avgChars: round(chars / messages),
    particlesPerMsg: round(particles / messages),
    addressPerMsg: round(address / messages),
    emojiPerMsg: round(emoji / messages),
  };
}

function ratio(a: number, b: number): number {
  if (b === 0) return a === 0 ? 0 : 1;
  return Math.abs(a - b) / b;
}

/** 对比两段指纹；偏差按各维度相对变化的最大值算。 */
export function compareFingerprints(
  previous: Fingerprint,
  current: Fingerprint,
  threshold = DRIFT_THRESHOLD,
): FingerprintComparison {
  const reasons: string[] = [];
  if (previous.messages < 5 || current.messages < 5) {
    return {
      current,
      previous,
      drift: 0,
      drifted: false,
      reasons: ['样本太少，不做判断（至少各 5 条）'],
    };
  }
  const dims: Array<[string, number, number]> = [
    ['平均句长', previous.avgChars, current.avgChars],
    ['语气词', previous.particlesPerMsg, current.particlesPerMsg],
    ['称呼', previous.addressPerMsg, current.addressPerMsg],
    ['表情', previous.emojiPerMsg, current.emojiPerMsg],
  ];
  let drift = 0;
  for (const [name, before, after] of dims) {
    const r = ratio(after, before);
    if (r > drift) drift = r;
    if (r > threshold) {
      reasons.push(name + '变化 ' + Math.round(r * 100) + '%（' + before + ' → ' + after + '）');
    }
  }
  return {
    current,
    previous,
    drift: Math.round(drift * 100) / 100,
    drifted: drift > threshold,
    reasons,
  };
}

/** 近 7 天 vs 前 7 天，用她的发言算指纹。 */
export async function loadPersonaDrift(
  env: Env,
  now = Date.now(),
): Promise<FingerprintComparison> {
  const day = 86400000;
  const recentStart = now - 7 * day;
  const previousStart = now - 14 * day;

  const load = async (from: number, to: number): Promise<string[]> => {
    try {
      const res = await env.DB.prepare(
        `SELECT content FROM messages
         WHERE role = 'assistant' AND created_ms >= ? AND created_ms < ?
         ORDER BY id DESC LIMIT 400`,
      )
        .bind(from, to)
        .all<{ content: string }>();
      return (res.results ?? []).map((r) => String(r.content));
    } catch {
      return [];
    }
  };

  const [current, previous] = await Promise.all([
    load(recentStart, now),
    load(previousStart, recentStart),
  ]);
  return compareFingerprints(buildFingerprint(previous), buildFingerprint(current));
}
