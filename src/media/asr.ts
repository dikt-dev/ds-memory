/**
 * 语音识别（Workers AI whisper）：视频里到底说了什么。
 *
 * 为什么不交给视觉模型：画面能看出「在说话」，看不出「说了什么」。
 * 台词是中文短视频里信息密度最高的部分，而 ASR 给的还是带时间戳的原文——
 * 可以直接写进观察卡、可以直接被引用、可以核对。
 *
 * 结果按音频内容哈希缓存：同一段视频重复发、或者前后两条消息是同一个文件，
 * 不会重复计费。
 */
import type { Env } from '../types';

export interface AsrLine {
  /** 秒 */
  t: number;
  text: string;
}

export interface AsrResult {
  lines: AsrLine[];
  /** 命中缓存就不再调模型 */
  cached: boolean;
}

/**
 * 依次尝试的识别方案。
 *
 * 1. turbo + 简体提示词：whisper 的中文默认容易输出繁体，
 *    给一句简体 initial prompt 通常能把它掰回来；
 * 2. 如果模型不接受 prompt 字段，退回不带提示的 turbo；
 * 3. 最后用小模型兜底。全挂就抛错，由调用方降级成「没有台词」。
 */
const ASR_ATTEMPTS: { model: string; extra: Record<string, unknown> }[] = [
  {
    model: '@cf/openai/whisper-large-v3-turbo',
    extra: { prompt: '以下是普通话内容，请用简体中文转写。' },
  },
  { model: '@cf/openai/whisper-large-v3-turbo', extra: {} },
  { model: '@cf/openai/whisper', extra: {} },
];
const CACHE_PREFIX = 'asr2:';
const CACHE_TTL_S = 60 * 60 * 24 * 14;
/**
 * 单次上限 8 MB。
 *
 * 不是 whisper 的限制，是「字节数组要当 JSON 发过去」这件事的限制：
 * 8 MB 音频序列化后约 30 MB，再大容易把 Worker 内存顶掉。
 * 一分钟的 m4a 大约 1 MB，8 MB 够十来分钟。
 */
export const ASR_MAX_BYTES = 8 * 1024 * 1024;

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function fingerprint(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', bytes);
  return hex(digest).slice(0, 24);
}

/**
 * ArrayBuffer → number[]。
 *
 * whisper 这个模型只吃字节数组，不接受 base64 字符串（实测报 oneOf 不匹配）。
 * 数组会被序列化成 JSON，体积大约是音频的 3~4 倍，所以上限压到 8 MB。
 */
function toByteArray(bytes: ArrayBuffer): number[] {
  return Array.from(new Uint8Array(bytes));
}

interface WhisperOut {
  text?: string;
  words?: { word?: string; start?: number; end?: number }[];
  segments?: { text?: string; start?: number; end?: number }[];
}

/**
 * 把词级时间戳拼成「一句话一行」。
 *
 * whisper 有时只给整段 text、有时给 words、有时给 segments，三种都接。
 * 词级的情况下按停顿切句：间隔超过 1.1 秒，或者这一行已经超过 24 个字。
 */
function toLines(out: WhisperOut): AsrLine[] {
  if (Array.isArray(out.segments) && out.segments.length > 0) {
    return out.segments
      .filter((s) => typeof s?.text === 'string' && s.text.trim())
      .map((s) => ({ t: Math.max(0, Math.round((s.start ?? 0) * 10) / 10), text: s.text!.trim() }));
  }
  if (Array.isArray(out.words) && out.words.length > 0) {
    const lines: AsrLine[] = [];
    let start = -1;
    let buf = '';
    let lastEnd = 0;
    for (const w of out.words) {
      const word = (w.word ?? '').trim();
      if (!word) continue;
      const at = Math.max(0, w.start ?? 0);
      const gap = start >= 0 ? at - lastEnd : 0;
      if (start >= 0 && (gap > 1.1 || buf.length > 24 || /[。！？!?]/.test(buf))) {
        lines.push({ t: Math.round(start * 10) / 10, text: buf.trim() });
        start = -1;
        buf = '';
      }
      if (start < 0) start = at;
      // 中文词之间不补空格，英文词之间补
      buf += /[a-zA-Z0-9]$/.test(buf) && /^[a-zA-Z0-9]/.test(word) ? ' ' + word : word;
      lastEnd = Math.max(lastEnd, w.end ?? at);
    }
    if (buf.trim()) lines.push({ t: Math.round(Math.max(0, start) * 10) / 10, text: buf.trim() });
    return lines;
  }
  const text = (out.text ?? '').trim();
  if (!text) return [];
  // 没有时间戳：整段当一行，时间记 0（调用方会标注「时间点不准」）
  return [{ t: 0, text }];
}

/**
 * 清洗识别结果。
 *
 * whisper 在没有人声的片段上会疯狂复读（实测一个仪器运转的视频识别出
 * 几十行「-4-4-4-4…」），这些东西进了提示词只会让她编台词。三类都丢掉：
 *   1. 没有一个汉字的（纯数字、符号、英文乱码）
 *   2. 单字符重复占比过高的（-4-4-4、啊啊啊啊）
 *   3. 空耳常见的片尾话术（求订阅、字幕由某某提供）
 */
const BOILERPLATE = /(字幕由|字幕组|订阅|点赞|转发|打赏|感谢观看)/;

function isJunk(text: string): boolean {
  const cjk = (text.match(/[\u4e00-\u9fa5]/g) ?? []).length;
  if (cjk === 0) return true;
  const chars = [...text.replace(/\s/g, '')];
  if (chars.length >= 6) {
    const uniq = new Set(chars).size;
    if (uniq / chars.length < 0.25) return true;
  }
  if (BOILERPLATE.test(text) && cjk < 10) return true;
  return false;
}

/** 去掉人声之外的噪声行、去掉连续重复，再限制总行数。 */
export function cleanLines(lines: AsrLine[]): AsrLine[] {
  const out: AsrLine[] = [];
  for (const line of lines) {
    const text = line.text.trim();
    if (!text || isJunk(text)) continue;
    const prev = out[out.length - 1];
    if (prev && prev.text === text) continue;
    out.push({ t: line.t, text });
  }
  return out.slice(0, 120);
}

/** 识别一段音频。失败抛错，由调用方决定降级。 */
export async function transcribe(env: Env, audio: ArrayBuffer): Promise<AsrResult> {
  if (audio.byteLength === 0) return { lines: [], cached: false };
  const key = CACHE_PREFIX + (await fingerprint(audio));
  const hit = await env.KV.get(key, 'json').catch(() => null);
  if (Array.isArray(hit)) return { lines: cleanLines(hit as AsrLine[]), cached: true };

  const bytes = toByteArray(audio);
  let out: WhisperOut | null = null;
  let lastError: unknown = null;
  for (const { model, extra } of ASR_ATTEMPTS) {
    try {
      out = (await env.AI.run(model as never, { audio: bytes, ...extra } as never)) as WhisperOut;
      break;
    } catch (e) {
      lastError = e;
    }
  }
  if (!out) throw lastError instanceof Error ? lastError : new Error(String(lastError));
  const lines = cleanLines(toLines(out));
  if (lines.length > 0) {
    await env.KV.put(key, JSON.stringify(lines), { expirationTtl: CACHE_TTL_S }).catch(() => {});
  }
  return { lines, cached: false };
}
