/**
 * 给日记配一张图。
 *
 * 单独走 diary-images/ 目录：聊天图片有生命周期清理，日记配图要长期留着，
 * 混在一起早晚会被批量删掉。
 *
 * 生成失败一律返回 null —— 配图是锦上添花，不能让它把日记本身拖挂。
 */
import type { Env } from '../types';
import { getObject, putObject } from '../storage';
import { logError } from '../error-log';
import { completeDeepSeek } from '../deepseek';

const IMAGE_MODEL = '@cf/black-forest-labs/flux-1-schnell';

/** 可选模型：flux 风格好但不认否定词；两个 SD 系认否定词，画风偏实。 */
export const IMAGE_MODELS: Record<string, string> = {
  flux: '@cf/black-forest-labs/flux-1-schnell',
  lightning: '@cf/bytedance/stable-diffusion-xl-lightning',
  dreamshaper: '@cf/lykon/dreamshaper-8-lcm',
  sdxl: '@cf/stabilityai/stable-diffusion-xl-base-1.0',
};

/** SD 系支持的否定词——flux 没有这个参数，所以只在 SD 上带。 */
const NEGATIVE = 'text, letters, chinese characters, calligraphy, watermark, signature, caption, logo';

export function diaryImageKey(dateKey: string, name = 'cover', ext = 'jpg', stamp?: string): string {
  // 带时间戳：同一天重画时换个 key，客户端才不会一直拿缓存里的旧图
  const v = stamp ?? new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
  return `diary-images/${dateKey}/${name}-${v}.${ext}`;
}

/** 从日记正文里取一个可以画的场景。取开头两三句——那是当天的骨架。 */
export function imageScene(text: string): string {
  const body = text
    .split(/[。！？!?\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 4)
    .slice(0, 2)
    .join('，');
  // 实测：只写「不要文字」没用，flux 还是会画一排假汉字。
  // 换成英文指令 + 反复强调 no text，并指定日系水彩，画面才干净。
  return [
    'Japanese watercolor illustration, soft natural light, cozy slice-of-life scene.',
    'Scene: ' + body.slice(0, 100) + '.',
    'Style: muted pastel palette, gentle brush texture, shallow depth, calm mood.',
    'No text, no letters, no Chinese characters, no calligraphy, no captions, no watermark, no signature.',
    'No face close-up, no logo.',
  ].join(' ');
}

/** 最近一次失败原因（排查用，进程内即可）。 */
export let lastImageError: string | null = null;

/**
 * 固定形象：长蓝发、蓝眼、鳍耳、女仆发带、黑白女仆裙、身后一条鲸鱼尾巴。
 *
 * 之前没写死，模型每张都画一个随机的黑发路人——日记里明明是她自己，
 * 画面却像别人。形象必须当成常量，和画风分开写。
 */
export const CHARACTER =
  'the same character: a young woman with long blue hair, blue eyes, fin-like ears, ' +
  'a white maid headband, wearing a black-and-white maid dress, with a large whale tail behind her';

/** 统一的画风 + 固定人物：不管场景是什么，长相要一致。 */
export function withStyle(scene: string): string {
  return [
    'Japanese watercolor illustration, soft natural light, gentle brush texture, muted pastel palette.',
    CHARACTER + '.',
    'Scene: ' + scene,
    // 加了形象描述之后模型爱画成两个人——明确只画一个
    'Only one person in the frame.',
    'No text, no letters, no characters on screen, no watermark, no signature.',
  ].join(' ');
}

export async function generateDiaryImage(
  env: Env,
  dateKey: string,
  text: string,
  opts?: { model?: string; keyName?: string },
): Promise<string | null> {
  try {
    const model = IMAGE_MODELS[opts?.model ?? 'flux'] ?? IMAGE_MODEL;
    // 先问「这一天最该画的是哪一幕」，再画；失败就退回原来抽句子的做法
    const scene = (await diaryScenePrompt(env, text)) ?? imageScene(text);
    const isFlux = model === IMAGE_MODEL;
    const input = isFlux
      ? { prompt: withStyle(scene), steps: 4 }
      : { prompt: withStyle(scene), negative_prompt: NEGATIVE, num_steps: 4 };
    const out = (await env.AI.run(model as never, input as never)) as { image?: string };
    const anyOut = out as unknown as { image?: string; result?: { image?: string } };
    // 有的模型直接吐二进制流，不吐 base64
    let bin: Uint8Array | null = null;
    if (out instanceof ReadableStream) {
      bin = new Uint8Array(await new Response(out).arrayBuffer());
    } else {
      const b64 = anyOut?.image ?? anyOut?.result?.image;
      if (b64) bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    }
    if (!bin) {
      lastImageError = 'no image, keys=' + Object.keys(anyOut ?? {}).join(',') + ' bytes=' + (out ? JSON.stringify(out).length : 0) + ' sample=' + JSON.stringify(anyOut ?? null).slice(0, 200);
      return null;
    }
    if (bin.byteLength < 2048) {
      lastImageError = 'tiny image: ' + bin.byteLength;
      return null;
    }
    const key = diaryImageKey(dateKey, opts?.keyName);
    // putObject 成功时返回 void —— 不能拿返回值当成功标志
    await putObject(env, key, bin, { contentType: 'image/jpeg' });
    const back = await getObject(env, key).catch(() => null);
    if (!back) {
      lastImageError = 'r2 put verify failed';
      return null;
    }
    return key;
  } catch (e) {
    lastImageError = (e as Error)?.message ?? String(e);
    logError('[diary-image] 生成失败:', lastImageError);
    return null;
  }
}

/**
 * 让模型先把日记读成「一个能画的画面」，再交给 flux。
 *
 * 直接拿正文开头几句当提示词时，flux 只会画一张泛泛的水彩风景，
 * 跟日记里发生的事毫无关系（烤饼干、看漫画、逛书店全没体现）。
 * 所以中间加一步：用一次很便宜的调用，把日记压成一句**具体的英文场景**。
 */
export async function diaryScenePrompt(env: Env, text: string): Promise<string | null> {
  try {
    const res = await completeDeepSeek(
      env,
      [
        {
          role: 'system',
          content:
            'You turn a Chinese diary entry into ONE English image prompt (max 40 words). ' +
            'Pick the single most visual moment: the place, what she is doing, time of day, weather, key objects. ' +
            'Be concrete and physical. No metaphors, no emotions, no text in the image. ' +
            'Reply with the prompt only.',
        },
        { role: 'user', content: text.slice(0, 800) },
      ],
      new Date(),
      160,
    );
    if ('error' in res) return null;
    const line = res.text.trim().replace(/^["']|["']$/g, '').replace(/\s+/g, ' ');
    return line.length > 10 ? line.slice(0, 300) : null;
  } catch {
    return null;
  }
}
