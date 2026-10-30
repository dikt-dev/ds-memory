/**
 * Azure TTS 配置与合成（网页 / App 共用一份）。
 *
 * 为什么要有这个模块：
 * 原来网页的语音是「建任务 → 手机合成 → 传 R2 → 网页播放」，手机不在线就掉到
 * MeloTTS，声音和 App 完全不是一个人。现在把 App 的 voice/rate/pitch/style 存到
 * Cloudflare，两端都用同一份参数走 Azure，声音才对得上。
 */
import type { Env } from './types';
import { getObject, putObject } from './storage';

export const TTS_CONFIG_KEY = 'tts:config';

export interface TtsConfig {
  /** Azure voice short name，例如 zh-CN-XiaoyiNeural */
  voice: string;
  /** 语速，如 +5% */
  rate: string;
  /** 音调，如 +3Hz */
  pitch: string;
  /** 情绪强度，如 1.2 */
  style_degree: string;
  /** auto = 按文本关键词挑 style；off = 不用 style */
  style_mode: 'auto' | 'off';
  updated_at: number;
}

export const DEFAULT_TTS_CONFIG: TtsConfig = {
  voice: 'zh-CN-XiaoyiNeural',
  rate: '+5%',
  pitch: '+3Hz',
  style_degree: '1.2',
  style_mode: 'auto',
  updated_at: 0,
};

/** 只允许合法字符，防止把 SSML 注入进去。 */
export function sanitizeTtsConfig(raw: unknown, now = Date.now()): TtsConfig {
  const src = (raw ?? {}) as Record<string, unknown>;
  const str = (v: unknown, fallback: string) => (typeof v === 'string' && v.trim() ? v.trim() : fallback);
  const voice = str(src.voice, DEFAULT_TTS_CONFIG.voice);
  const rate = str(src.rate, DEFAULT_TTS_CONFIG.rate);
  const pitch = str(src.pitch, DEFAULT_TTS_CONFIG.pitch);
  const degree = str(src.style_degree, DEFAULT_TTS_CONFIG.style_degree);
  return {
    voice: /^[A-Za-z0-9-]{3,60}$/.test(voice) ? voice : DEFAULT_TTS_CONFIG.voice,
    rate: /^[0-9%+-]{1,8}$/.test(rate) ? rate : DEFAULT_TTS_CONFIG.rate,
    pitch: /^[0-9%+\-Hz]{1,10}$/.test(pitch) ? pitch : DEFAULT_TTS_CONFIG.pitch,
    style_degree: /^[0-9.]{1,4}$/.test(degree) ? degree : DEFAULT_TTS_CONFIG.style_degree,
    style_mode: src.style_mode === 'off' ? 'off' : 'auto',
    updated_at: now,
  };
}

export async function loadTtsConfig(env: Env): Promise<TtsConfig> {
  const raw = await env.KV.get(TTS_CONFIG_KEY).catch(() => null);
  if (!raw) return { ...DEFAULT_TTS_CONFIG };
  try {
    return sanitizeTtsConfig(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_TTS_CONFIG };
  }
}

export async function saveTtsConfig(env: Env, raw: unknown): Promise<TtsConfig> {
  const cfg = sanitizeTtsConfig(raw);
  await env.KV.put(TTS_CONFIG_KEY, JSON.stringify(cfg));
  return cfg;
}

/** 中文情绪关键词 → Azure style（从 App 的 TtsManager 平移，顺序从强到弱）。 */
export function styleForText(text: string): string {
  const t = text ?? '';
  const hit = (words: string[]) => words.some((w) => t.includes(w));
  if (hit(['耳语', '小声', '悄悄', '嘘'])) return 'whispering';
  if (hit(['傲娇', '毒舌', '嘴硬', '别扭', '嫌弃', '不屑', '冷哼', '哼'])) return 'disgruntled';
  if (hit(['炸毛', '生气', '愤怒', '恼火'])) return 'angry';
  if (hit(['委屈', '难过', '伤心', '想哭', '呜'])) return 'sad';
  if (hit(['别担心', '慢慢来', '安慰', '抱抱', '乖', '心软', '温柔', '撒娇', '喜欢'])) return 'gentle';
  if (hit(['太棒', '好耶', '惊喜', '激动', '兴奋', '冲呀'])) return 'excited';
  if (hit(['理解', '共情', '我懂', '辛苦', '不容易'])) return 'empathetic';
  if (hit(['得意', '开心', '高兴', '活泼', '笑'])) return 'cheerful';
  return '';
}
function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/'/g, '&apos;')
    .replace(/"/g, '&quot;');
}

/** 拼 SSML（纯函数，便于单测）。style 为空就不包 express-as。 */
export function buildSsml(text: string, config: TtsConfig, style: string): string {
  const inner = `<prosody rate='${escapeXml(config.rate)}' pitch='${escapeXml(config.pitch)}'>${escapeXml(text)}</prosody>`;
  const content = style
    ? `<mstts:express-as style='${escapeXml(style)}' styledegree='${escapeXml(config.style_degree)}'>${inner}</mstts:express-as>`
    : inner;
  return `<speak version='1.0' xml:lang='zh-CN' xmlns:mstts='https://www.w3.org/2001/mstts'><voice xml:lang='zh-CN' name='${escapeXml(config.voice)}'>${content}</voice></speak>`;
}

/** 缓存 key 含文本与全部参数：换音色后不会播到旧音频。 */
export async function ttsCacheKey(text: string, config: TtsConfig, style: string): Promise<string> {
  const material = [text, config.voice, config.rate, config.pitch, config.style_degree, style].join('\u0000');
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material));
  const hex = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `tts/cache/${hex.slice(0, 32)}.mp3`;
}

/** 调 Azure 合成；返回 mp3 字节。失败抛异常（调用方决定兜底）。 */
export async function synthesizeAzure(
  env: Env,
  text: string,
  config: TtsConfig,
  style: string,
): Promise<ArrayBuffer> {
  const key = env.AZURE_SPEECH_KEY;
  if (!key) throw new Error('AZURE_SPEECH_KEY 未配置');
  const region = (env.AZURE_SPEECH_REGION || 'eastus').replace(/[^a-z0-9-]/gi, '');
  const res = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': key,
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
      'User-Agent': 'DS-Worker-TTS',
    },
    body: buildSsml(text, config, style),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 200);
    throw new Error(`Azure TTS HTTP ${res.status}: ${detail}`);
  }
  return res.arrayBuffer();
}

/** 合成 + R2 缓存：同一句话同一套参数只付一次钱。 */
export async function speakWithCache(
  env: Env,
  text: string,
  opts: { style?: string; config?: TtsConfig } = {},
): Promise<{ key: string; audio: ArrayBuffer; cached: boolean }> {
  const config = opts.config ?? (await loadTtsConfig(env));
  const autoStyle = config.style_mode === 'auto' ? styleForText(text) : '';
  const style = opts.style !== undefined ? opts.style : autoStyle;
  const key = await ttsCacheKey(text, config, style);
  const hit = await getObject(env, key).catch(() => null);
  if (hit) return { key, audio: await hit.arrayBuffer(), cached: true };
  const audio = await synthesizeAzure(env, text, config, style);
  await putObject(env, key, audio, { contentType: 'audio/mpeg' }).catch(() => {});
  return { key, audio, cached: false };
}