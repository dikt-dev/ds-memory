/**
 * 人设开关：自称、关系定位、称呼风格、语气。
 *
 * 以前这几句写死在 prompt.ts 里，换人设必须改代码——
 * 这次重置记忆时踩到了：清空记忆后她仍然自称「本小姐」、仍然叫他「主人」。
 * 现在全部走环境变量，没配时保持旧行为（开源默认值不变）。
 */
import type { Env } from './types';

export interface PersonaConfig {
  /** 自称：本小姐 / 本鲸鱼娘 / 我 */
  selfCall: string;
  /** 关系定位：他的专属 AI 女友 / 嘴硬搭子 / 室友 */
  role: string;
  /** 有固定称呼时，后面跟的一句说明（可整句替换） */
  addressNote: string;
  /** auto = 按亲密度决定分寸；peer = 损友式，一开始就放松 */
  tone: 'auto' | 'peer';
  /** 她自己的长相（照片/视频里认出「这是我」用的），没配就空着 */
  look: string;
  /** true = 本轮不要任何人设文本（清空重置时用，见 PERSONA_PROFILE） */
  blank?: boolean;
}

export const DEFAULT_SELF_CALL = '本小姐';
export const DEFAULT_ROLE = '他的专属 AI 女友';
export const DEFAULT_ADDRESS_NOTE =
  '但平时更常叫他"大笨蛋"（撒娇、认真、心疼的时候才叫"主人"）';

export function resolvePersona(env: Partial<Env> | undefined): PersonaConfig {
  // PERSONA_PROFILE=none：连"没配就用开源默认值"都不要，提示词里一句人设都不留。
  // 清空重置/换人设的窗口期用它，否则空值会回退到默认的「本小姐/专属 AI 女友」。
  if ((env?.PERSONA_PROFILE ?? '').trim() === 'none') {
    return { selfCall: '', role: '', addressNote: '', tone: 'auto', look: '', blank: true };
  }
  const selfCall = env?.PERSONA_SELF_CALL?.trim() || DEFAULT_SELF_CALL;
  const role = env?.PERSONA_ROLE?.trim() || DEFAULT_ROLE;
  const addressNote = env?.PERSONA_ADDRESS_NOTE?.trim() || DEFAULT_ADDRESS_NOTE;
  const tone = env?.PERSONA_TONE?.trim() === 'peer' ? 'peer' : 'auto';
  const look = env?.PERSONA_LOOK?.trim() || '';
  return { selfCall, role, addressNote, tone, look };
}
