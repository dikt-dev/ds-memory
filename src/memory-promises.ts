/**
 * 未闭环承诺：从记忆的「答应过的事」里取出还没做完的，每轮固定注入。
 *
 * 为什么单独一层（2026-11-08 探针第 9 题）：问「你答应过我什么」时她完全回避——
 * 因为承诺散落在「共同经历」里，靠关键词召回常常捞不到。
 */
export const PROMISES_SECTION = '## 答应过的事';

export interface PromiseItem {
  date: string;
  text: string;
  done: boolean;
}

/** 从 memory.md 里解析承诺条目（纯函数，方便测）。 */
export function parsePromises(memory: string): PromiseItem[] {
  const out: PromiseItem[] = [];
  let inSection = false;
  for (const raw of (memory || '').split('\n')) {
    const line = raw.trim();
    if (line.startsWith('## ')) {
      inSection = line === PROMISES_SECTION;
      continue;
    }
    if (!inSection || !line.startsWith('- ')) continue;
    const body = line.slice(2);
    const date = body.match(/^\[(\d{2,4}-\d{2}-\d{2})\]/)?.[1] ?? '';
    const text = body.replace(/^\[[^\]]*\]\s*/, '').trim();
    if (!text) continue;
    out.push({ date, text, done: /（已完成）|\(已完成\)/.test(text) });
  }
  return out;
}

/** 取还没做完的承诺（最多 n 条，按日期从新到旧）。 */
export function pendingPromises(memory: string, n = 3): PromiseItem[] {
  return parsePromises(memory)
    .filter((p) => !p.done)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, n);
}

/** 注入成一小段文字；没有未完成承诺时返回空串。 */
export function promisesBlock(memory: string, n = 3): string {
  const items = pendingPromises(memory, n);
  if (items.length === 0) return '';
  return ['还没做完的约定：', ...items.map((p) => `- ${p.text}`)].join('\n');
}
