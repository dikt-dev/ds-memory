/**
 * 聊天提示词里「她自己的生活」这一块：名录 + 此刻状态 + 当天住户卡片。
 *
 * 以前这段在 chat.ts 和 openai.ts 各写一遍，住户上线时只改了 chat.ts，
 * 结果线上（走 openai.ts）完全没生效。现在只有这一个来源。
 */
import type { Env } from './types';
import { lifePromptLine, residentNowLine } from './life/now-text';
import { residentLooksRoster, residentRoster } from './life/residents';
import { resolvePersona } from './persona';

export interface LifeBlocks {
  /** 稳定段：公寓名录（每天不变，能命中前缀缓存） */
  residents: string | null;
  /** 易变段：此刻在干什么 + 今天跟谁混（每轮都变） */
  life: string | null;
}

export async function loadLifeBlocks(env: Env, now: Date): Promise<LifeBlocks> {
  const [line, card] = await Promise.all([
    lifePromptLine(env, now).catch(() => null),
    residentNowLine(env, now).catch(() => null),
  ]);
  return {
    // 名录 + 长相：名字解决「谁住这儿」，长相解决「照片里这个是谁」。
    // 自己的长相放在最前面——先认出「这是我」，再谈别人。
    residents:
      [
        (() => {
          const look = resolvePersona(env).look;
          return look ? `你自己：${look}。照片或画面里出现这样的人，那就是你，别当成别人。` : '';
        })(),
        residentRoster(),
        residentLooksRoster(),
      ]
        .filter(Boolean)
        .join('\n\n') || null,
    life: [line, card].filter(Boolean).join('\n\n') || null,
  };
}
