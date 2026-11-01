/**
 * 旅行见闻配图（§11.2.1）。
 *
 * 口径是「她拍的碎片」，不是明信片：第一人称、只手边的东西、不拍地标。
 * 地标图一眼假（模型画不对西湖），而「桌上两块桂花糕」既像她拍的，
 * 又符合她只分享碎片的方式。
 *
 * 统一滤镜让所有图看起来像同一台相机拍的——这点比单张好不好看重要。
 */
import type { Env } from '../types';
import { putObject } from '../storage';
import { logError } from '../error-log';

/** 所有图共用的风格串。改这一行等于给她的相机换胶卷。 */
export const PHOTO_STYLE =
  '35mm film photo, slight grain, warm tungsten light, shallow depth of field, casual snapshot, not professional, no text';

/** 不要人、不要地标：她拍的是「手边」，不是游客照。 */
const NEGATIVE = 'no people, no faces, no landmarks, no postcard view';

export interface PhotoResult {
  ok: boolean;
  key?: string;
  error?: string;
}

export async function generatePhoto(
  env: Env,
  input: { scene: string; dateKey: string; seed?: number },
): Promise<PhotoResult> {
  const prompt = `${input.scene}, ${PHOTO_STYLE}, ${NEGATIVE}`;
  try {
    // flux-1-schnell 只认 prompt/steps/seed，多传字段会直接报 5006
    const out = (await env.AI.run('@cf/black-forest-labs/flux-1-schnell' as never, {
      prompt,
      ...(input.seed !== undefined ? { seed: input.seed } : {}),
    } as never)) as { image?: string } | undefined;
    const b64 = out?.image;
    if (!b64) return { ok: false, error: '模型没返回图片' };
    const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
    const key = `images/ai-photo/${input.dateKey}/${crypto.randomUUID().slice(0, 8)}.jpg`;
    await putObject(env, key, bytes, { contentType: 'image/jpeg' });
    return { ok: true, key };
  } catch (e) {
    logError('[life] 生成见闻图失败:', e);
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
