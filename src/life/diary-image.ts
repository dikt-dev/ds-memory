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
import { loadPersonaDoc, personaSectionText } from '../persona-doc';

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
 * 固定形象（鲸鱼娘）：深蓝紫到浅蓝渐变的长波浪发、一根弧形呆毛、圆蓝瞳、
 * 蓝白鲸鳍状耳、白色褶边头箍 + 蓝色蝴蝶结、深蓝白女仆裙（金色点缀）、
 * 蓝色椭圆胸针、围裙上的蓝鲸图案、身后一条大鲸鱼尾巴。等身比例，不用 Q 版。
 *
 * 之前没写死，模型每张都画一个随机的黑发路人——日记里明明是她自己，
 * 画面却像别人。形象必须当成常量，和画风分开写。
 */
export const CHARACTER =
  'the same character: a young woman with long blue hair, blue eyes, fin-like ears, ' +
  'an ahoge on top of her head, a white maid headband, wearing a black-and-white maid dress, ' +
  'with a large whale tail behind her';

/** 人设里「外貌」那段在 KV 里的缓存键：内容变了 key 就变，自动失效。 */
function appearanceKey(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return 'diary:appearance:' + (h >>> 0).toString(16);
}

/**
 * 把 persona.md 的「外貌」段翻成英文图像提示词片段。
 *
 * 为什么要翻：flux 只吃英文提示词，直接塞中文等于没写。
 * 为什么要缓存：每张图都调一次模型太贵；key 由内容哈希决定，改了人设自动换 key。
 * 失败就退回代码里的常量——形象宁可旧一点，也不能每张随机。
 */
export async function appearancePrompt(env: Env): Promise<string> {
  const doc = await loadPersonaDoc(env).catch(() => '');
  const raw = personaSectionText(doc, '外貌')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^[-*]\s*(生气|高兴|心虚|动作)/.test(l))
    .join(' ');
  if (!raw) return CHARACTER;
  const key = appearanceKey(raw);
  const cached = await env.KV.get(key).catch(() => null);
  if (cached) return cached;
  try {
    const res = await completeDeepSeek(
      env,
      [
        {
          role: 'system',
          content:
            'Turn a Chinese character description into ONE English image-prompt fragment (max 45 words). ' +
            'Keep hair color/length, eyes, ears, hair ornaments, outfit, tail and any distinctive marks. ' +
            'Start with "the same character: a young woman with". No scene, no pose, no emotions. Reply with the fragment only.',
        },
        { role: 'user', content: raw.slice(0, 400) },
      ],
      new Date(),
      140,
    );
    const line = 'error' in res ? '' : res.text.trim().replace(/^["']|["']$/g, '').replace(/\s+/g, ' ');
    if (!line) return CHARACTER;
    await env.KV.put(key, line, { expirationTtl: 90 * 24 * 3600 }).catch(() => {});
    return line;
  } catch {
    return CHARACTER;
  }
}

/**
 * 按场景换衣服。
 *
 * CHARACTER 里的女仆裙是她的常服，但日记里写到睡觉、洗澡、做饭、出门，
 * 还穿着女仆装就明显不对——衣服要跟着这天在干什么走。
 */
export function outfitFor(scene: string): string {
  const t = scene.toLowerCase();
  if (/睡|被窝|枕头|床|夜|睡衣|bed|sleep|pajama|blanket/.test(t)) {
    return 'wearing a loose pastel pajama set, hair a little messy';
  }
  if (/做饭|厨房|煮|烤|炒|洗碗|cook|kitchen|bake/.test(t)) {
    return 'wearing a white apron over a casual dress';
  }
  if (/超市|街|地铁|雨|伞|出门|公园|书店|walk|street|shop|store|umbrella|coat/.test(t)) {
    return 'wearing a light coat and scarf, carrying a bag';
  }
  return 'wearing a black-and-white maid dress';
}

/** 统一的画风 + 固定人物：不管场景是什么，长相要一致。 */
export function withStyle(scene: string, appearance: string = CHARACTER): string {
  return [
    'Japanese watercolor illustration, soft natural light, gentle brush texture, muted pastel palette.',
    // 形象来自人设（appearancePrompt 读 persona.md 的「外貌」段）；
    // 衣服按场景覆盖，避免睡觉也穿女仆裙
    appearance + '.',
    'She is ' + outfitFor(scene) + '.',
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
    const appearance = await appearancePrompt(env).catch(() => CHARACTER);
    const prompt = withStyle(scene, appearance);
    const input = isFlux
      ? { prompt, steps: 4 }
      : { prompt, negative_prompt: NEGATIVE, num_steps: 4 };
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
