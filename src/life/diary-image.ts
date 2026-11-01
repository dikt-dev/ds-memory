/**
 * 给日记配一张图。
 *
 * 单独走 diary-images/ 目录：聊天图片有生命周期清理，日记配图要长期留着，
 * 混在一起早晚会被批量删掉。
 *
 * 生成失败一律返回 null —— 配图是锦上添花，不能让它把日记本身拖挂。
 */
import type { Env } from '../types';
import { putObject } from '../storage';
import { logError } from '../error-log';

const IMAGE_MODEL = '@cf/black-forest-labs/flux-1-schnell';

export function diaryImageKey(dateKey: string, ext = 'jpg'): string {
  return `diary-images/${dateKey}/cover.${ext}`;
}

/** 从日记正文里取一个可以画的场景。取开头两三句——那是当天的骨架。 */
export function imageScene(text: string): string {
  const body = text
    .split(/[。！？!?\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 4)
    .slice(0, 3)
    .join('。');
  return [
    '日系水彩插画，柔和的自然光，安静的生活气息。',
    '画面内容：' + body.slice(0, 140),
    '不要文字，不要字母，不要正脸特写。',
  ].join('');
}

export async function generateDiaryImage(env: Env, dateKey: string, text: string): Promise<string | null> {
  try {
    const out = (await env.AI.run(IMAGE_MODEL as never, {
      prompt: imageScene(text),
      num_steps: 4,
    } as never)) as { image?: string };
    const b64 = out?.image;
    if (!b64 || b64.length < 512) return null;
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    if (bin.byteLength < 2048) return null;
    const key = diaryImageKey(dateKey);
    const ok = await putObject(env, key, bin, { contentType: 'image/jpeg' }).catch(() => false);
    return ok ? key : null;
  } catch (e) {
    logError('[diary-image] 生成失败:', (e as Error)?.message ?? e);
    return null;
  }
}
