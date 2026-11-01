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

/**
 * 负面词。文字类要写死：画面里一出现带字的物件（包装、招牌、标签），
 * 模型就会画出乱码——这是实测里最明显的穿帮点。
 */
const NEGATIVE =
  'no people, no faces, no landmarks, no postcard view, no text, no letters, ' +
  'no signs, no labels, no packaging, no logos, no watermark';

/**
 * 能稳定出图的题材。没在这里的题材一律不出图——
 * 桂花糕那次就是反例：模型不认识的东西，画出来必然穿帮。
 */
export const SAFE_SCENES: Array<{ prompt: string; tags: string[] }> = [
  { prompt: 'a rain-streaked window from inside, blurry warm street lights outside', tags: ['雨', '窗', '檐', '湿', '阴'] },
  { prompt: 'a window with autumn sunlight falling across a wooden sill, dust in the light', tags: ['太阳', '阳光', '晒', '晴', '窗'] },
  { prompt: 'worn canvas sneakers on wet stone steps, fallen autumn leaves', tags: ['鞋', '台阶', '石阶', '湿', '走', '脚'] },
  { prompt: 'a bowl of hot noodles on a small wooden table, steam rising, chopsticks resting', tags: ['面', '汤', '碗', '吃', '热'] },
  { prompt: 'a glass of iced tea on a scratched wooden table, afternoon light, condensation', tags: ['喝', '杯', '豆浆', '茶', '咖啡', '冰'] },
  { prompt: 'a narrow old street seen from waist height, blurred hanging lanterns, warm evening light', tags: ['街', '巷', '灯', '人潮', '路口'] },
  { prompt: 'a paper cup of hot tea held in one hand, blurred street behind', tags: ['手', '捧', '拿', '握', '掌心', '拎'] },
  { prompt: 'a quiet wet alley corner, moss on stone, soft overcast light', tags: ['巷', '湿', '路', '安静'] },
];

/**
 * 按文案里的词挑画面：先算每个画面的标签命中数，命中多的优先。
 *
 * 不能只看「有没有雨」——实测里文案写「雨还没停」，图却是晴天窗台，
 * 图字对不上比不配图更假。
 */
export function pickScene(text: string, rng: () => number): string | null {
  let best = -1;
  let pool: string[] = [];
  for (const scene of SAFE_SCENES) {
    const score = scene.tags.reduce((n, tag) => (text.includes(tag) ? n + 1 : n), 0);
    if (score > best) {
      best = score;
      pool = [scene.prompt];
    } else if (score === best) pool.push(scene.prompt);
  }
  if (pool.length === 0) return null;
  return pool[Math.floor(rng() * pool.length)] ?? null;
}

export interface PhotoResult {
  ok: boolean;
  key?: string;
  error?: string;
}

export async function generatePhoto(
  env: Env,
  input: { scene: string; dateKey: string },
): Promise<PhotoResult> {
  // 注意：flux-1-schnell 不认 seed/num_steps，多传字段会直接 5006
  const prompt = `${input.scene}, ${PHOTO_STYLE}, ${NEGATIVE}`;
  try {
    const out = (await env.AI.run('@cf/black-forest-labs/flux-1-schnell' as never, {
      prompt,
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
