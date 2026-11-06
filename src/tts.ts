/**
 * 网页 TTS 队列：手机客户端优先合成，Worker MeloTTS 兜底。
 *
 * 手机在 NAT 后，不能直连；手机主动拉 pending 任务，合成 MP3 后上传 R2 并 ack。
 */
import type { Env } from './types';
import { dateKeyInBeijing, isoInBeijing } from './date';
import { buildAudioKey } from './media';
import { putObject } from './storage';

const LEASE_SECONDS = 90;
const MAX_ATTEMPTS = 3;

export interface TtsJob {
  id: number;
  text: string;
  status: string;
  audio_key: string | null;
  attempts: number;
  lease_until: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * 语音文本清洗：**只有念出来的那一份**去括号。
 *
 * 括号里是动作和语气（「（顿了一下）」「（语气软下来）」），念出来就成了解说词；
 * 但正常聊天消息里要原样保留——2026-11-06 起，后处理不再删普通消息的括号。
 */
export function cleanSpeechText(text: string): string {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\[face[:：][^\]]{1,12}\]/gi, '')
    .replace(/\[(?:图片|文件|语音|voice)[^\]]*\]/gi, '')
    // 动作/语气括号整段去掉（只影响念出来的这一份）
    .replace(/[（(][^（）()]{0,80}[）)]/g, '')
    .replace(/[#*_`>~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function createTtsJob(env: Env, text: string): Promise<number> {
  const clean = cleanSpeechText(text).slice(0, 300);
  if (!clean) return 0;
  const now = isoInBeijing();
  const row = await env.DB.prepare(
    `INSERT INTO tts_jobs (text, status, created_at, updated_at)
     VALUES (?, 'pending', ?, ?) RETURNING id`,
  )
    .bind(clean, now, now)
    .first<{ id: number }>();
  return row?.id ?? 0;
}

export async function getTtsJob(env: Env, id: number): Promise<TtsJob | null> {
  return env.DB.prepare(
    `SELECT id, text, status, audio_key, attempts, lease_until, created_at, updated_at
       FROM tts_jobs WHERE id = ?`,
  )
    .bind(id)
    .first<TtsJob>();
}

/** 手机端认领一个任务；processing 超时（90s）可被重新认领。 */
export async function claimTtsJob(env: Env): Promise<TtsJob | null> {
  const now = new Date();
  const stale = isoInBeijing(new Date(now.getTime() - LEASE_SECONDS * 1000));
  const lease = isoInBeijing(new Date(now.getTime() + LEASE_SECONDS * 1000));
  const row = await env.DB.prepare(
    `SELECT id, text, status, audio_key, attempts, lease_until, created_at, updated_at
       FROM tts_jobs
      WHERE status = 'pending'
         OR (status = 'processing' AND (lease_until IS NULL OR lease_until < ?))
      ORDER BY id ASC LIMIT 1`,
  )
    .bind(stale)
    .first<TtsJob>();
  if (!row) return null;
  await env.DB.prepare(
    `UPDATE tts_jobs
        SET status='processing', attempts=attempts+1, lease_until=?, updated_at=?
      WHERE id=?`,
  )
    .bind(lease, isoInBeijing(now), row.id)
    .run();
  return { ...row, status: 'processing', lease_until: lease, attempts: row.attempts + 1 };
}

export async function ackTtsJob(env: Env, id: number, audioKey: string): Promise<void> {
  if (!audioKey.startsWith('audio/')) return;
  await env.DB.prepare(
    `UPDATE tts_jobs
        SET status='done', audio_key=?, text='', lease_until=NULL, updated_at=?
      WHERE id=?`,
  )
    .bind(audioKey, isoInBeijing(), id)
    .run();
}

export async function nackTtsJob(env: Env, id: number): Promise<void> {
  const row = await getTtsJob(env, id);
  if (!row) return;
  const status = row.attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
  await env.DB.prepare(
    `UPDATE tts_jobs SET status=?, lease_until=NULL, updated_at=? WHERE id=?`,
  )
    .bind(status, isoInBeijing(), id)
    .run();
}

/** Worker MeloTTS 兜底：生成 MP3 存 R2，返回 audio key。 */
export async function generateMeloTtsKey(env: Env, text: string): Promise<string | null> {
  const clean = cleanSpeechText(text).slice(0, 300);
  if (!clean) return null;
  const out = (await env.AI.run(
    '@cf/myshell-ai/melotts' as never,
    { prompt: clean, lang: 'zh' } as never,
  )) as unknown;
  let bytes: Uint8Array | null = null;
  if (out instanceof Response) {
    bytes = new Uint8Array(await out.arrayBuffer());
  } else if (typeof out === 'string') {
    bytes = Uint8Array.from(atob(out), (ch) => ch.charCodeAt(0));
  } else if (out && typeof out === 'object' && typeof (out as { audio?: unknown }).audio === 'string') {
    bytes = Uint8Array.from(atob((out as { audio: string }).audio), (ch) => ch.charCodeAt(0));
  }
  if (!bytes || bytes.length === 0) return null;
  const key = buildAudioKey(dateKeyInBeijing(new Date()), Date.now(), 'mp3');
  await putObject(env, key, bytes, { contentType: 'audio/mpeg' });
  return key;
}

/** 网页等手机超时后调用：直接生成兜底音频并完成任务。 */
export async function fallbackTtsJob(env: Env, id: number): Promise<string | null> {
  const row = await getTtsJob(env, id);
  if (!row) return null;
  if (row.status === 'done' && row.audio_key) return row.audio_key;
  if (!row.text) return null;
  const key = await generateMeloTtsKey(env, row.text);
  if (!key) return null;
  await ackTtsJob(env, id, key);
  return key;
}