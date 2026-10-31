/**
 * 纠正联动（ADR-001 S5）。
 *
 * 用户说"不是这样，是那样"时，受影响的旧事实永久降权：
 * 它们仍然留在库里（不变量 2），但注入排序会靠后，措辞也会带"存疑"。
 */
import type { Env } from './types';
import { recordAction } from './memory-actions';
import { applySignal } from './fact-confidence';

/**
 * 找出被这次纠正波及的事实，逐条降权。
 *
 * 匹配口径故意宽：key 命中（content 以 "key=" 开头）或文本包含被纠正的关键片段。
 */
export async function penalizeCorrectedFact(
  env: Env,
  needle: string,
  now: Date = new Date(),
): Promise<number> {
  const term = (needle ?? '').trim();
  if (!term) return 0;
  const like = '%' + term.replace(/[%_]/g, '') + '%';
  const rows = await env.DB.prepare(
    `SELECT id, confidence, content FROM memory_facts
     WHERE content LIKE ? AND (valid_to IS NULL OR valid_to = '')
     LIMIT 20`,
  )
    .bind(like)
    .all<{ id: string; confidence: number; content: string }>();
  const hits = rows.results ?? [];
  if (hits.length === 0) return 0;

  let changed = 0;
  for (const hit of hits) {
    const next = applySignal(Number(hit.confidence) || 0, 'user_correct');
    const res = await env.DB.prepare(
      'UPDATE memory_facts SET confidence = ?, updated_at = ? WHERE id = ?',
    )
      .bind(next, now.getTime(), hit.id)
      .run();
    changed += Number(res?.meta?.changes ?? 0);
  }
  if (changed > 0) {
    await recordAction(
      env,
      {
        actor: 'human',
        kind: 'fact.expire',
        intent: '用户纠正了相关说法，受影响事实降权（保留可查）',
        evidence: hits.map((h) => 'fact:' + h.id),
        diff: hits
          .map((h) => h.id + ' confidence→' + applySignal(Number(h.confidence) || 0, 'user_correct'))
          .join('; ')
          .slice(0, 2000),
        before: changed + ' 条事实维持原置信度',
        after: changed + ' 条降权',
        revertible: true,
      },
      now.getTime(),
    );
  }
  return changed;
}
