/**
 * 日记摘要（只给授权判断用，永远不出给用户）。
 *
 * 写在同一次生成里最省，但模型有时把 JSON 那行漏掉或被截断，
 * 所以留一个兜底：正文有了、摘要没有，就单独补一次，很便宜。
 */
import type { Env } from '../types';
import { completeDeepSeek } from '../deepseek';

export const SUMMARY_SYSTEM =
  '你在帮一个角色给她自己的日记写备忘。只输出一句话，30 字以内，回答三件事：这篇里有没有他（提到了什么）、有没有暴露软肋（吃醋/委屈/自我怀疑/想他）、她当时大概什么心情。不是剧情简介，不要写推送文案或标题。';

/** 正文 → 一句话摘要；失败返回 null（调用方当没有摘要处理）。 */
export async function generateDiarySummary(env: Env, text: string): Promise<string | null> {
  const res = await completeDeepSeek(
    env,
    [
      { role: 'system', content: SUMMARY_SYSTEM },
      { role: 'user', content: '她的日记正文：\n' + text },
    ],
    new Date(),
    120,
  ).catch(() => null);
  if (!res || 'error' in res) return null;
  const summary = res.text.trim().replace(/\s+/g, ' ').slice(0, 80);
  return summary || null;
}
