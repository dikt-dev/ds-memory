/**
 * 提示词指纹（轻量，不是安全哈希）。
 *
 * 用途：判断"这两次请求的输入是不是几乎一样"。
 * 2026-11-10 出现过两次逐字复读：同一句话被生成两遍、token 数完全相同。
 * 要在事后从 D1 里认出"哪两轮的 prompt 撞了"，就得有一个能存的指纹。
 */

export interface PromptFingerprint {
  /** FNV-1a 32 位，8 位十六进制 */
  hash: string;
  /** 拼起来的字符数（粗略体积） */
  chars: number;
}

export function promptFingerprint(
  messages: Array<{ role: string; content: unknown }>,
): PromptFingerprint {
  const text = (messages ?? [])
    .map((m) => m.role + ':' + (typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')))
    .join('\n');
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return { hash: h.toString(16).padStart(8, '0'), chars: text.length };
}
