/**
 * facts.md：给人看的记忆白皮书（ADR-001 S12）。
 *
 * 只读投影，**不进提示词**——提示词只带宪法 + 召回证据。
 * 它的用途是：你想知道"她到底记得什么"时，直接看这份文件，不用查库；
 * 出问题时也能一眼分清是哪一层坏了。
 */
import type { Env } from './types';
import { putObject } from './storage';
import { confidenceTag } from './fact-confidence';

export interface FactDocRow {
  section: string;
  content: string;
  confidence: number;
  valid_from: string | null;
  valid_to: string | null;
  subject: string | null;
  predicate: string | null;
}

const SECTION_ORDER = [
  '人物底色',
  '称呼与关系',
  '关于用户',
  '偏好与习惯',
  '进行中的事项',
  '共同经历',
  '你的生活',
  '雷区与禁忌',
  '用户更正',
  '近期动态',
];

function orderOf(section: string): number {
  const idx = SECTION_ORDER.findIndex((s) => section.includes(s));
  return idx < 0 ? SECTION_ORDER.length : idx;
}

/** 渲染成 markdown：按分区、失效的单独标注、带可信度与生效时间。 */
export function renderFactsDoc(rows: FactDocRow[], today = ''): string {
  const lines: string[] = ['# 她记得的事（只读投影）', ''];
  lines.push('> 由 memory_facts 自动生成，**不参与提示词注入**；带「已失效」的是历史事实，保留用于时间旅行查询。');
  if (today) lines.push('> 生成日期：' + today);
  lines.push('');

  const active = rows.filter((r) => !r.valid_to || r.valid_to === '');
  const expired = rows.filter((r) => r.valid_to && r.valid_to !== '');

  const bySection = new Map<string, FactDocRow[]>();
  for (const row of active) {
    const key = row.section || '未分区';
    const list = bySection.get(key) ?? [];
    list.push(row);
    bySection.set(key, list);
  }

  const sections = [...bySection.keys()].sort((a, b) => orderOf(a) - orderOf(b) || a.localeCompare(b));
  for (const section of sections) {
    lines.push('## ' + section);
    const items = (bySection.get(section) ?? []).sort((a, b) => {
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      return (a.content ?? '').localeCompare(b.content ?? '');
    });
    for (const item of items) {
      const tag = confidenceTag(item.confidence);
      const since = item.valid_from ? '（自 ' + item.valid_from + '）' : '';
      lines.push('- ' + item.content + '  _' + tag + since + '_');
    }
    lines.push('');
  }

  if (expired.length > 0) {
    lines.push('## 已失效（历史）');
    const sorted = expired
      .sort((a, b) => String(b.valid_to).localeCompare(String(a.valid_to)))
      .slice(0, 100);
    for (const item of sorted) {
      lines.push('- ' + item.content + '  _失效于 ' + item.valid_to + '_');
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('共 ' + active.length + ' 条有效、' + expired.length + ' 条已失效。');
  return lines.join('\n');
}

export async function buildFactsDocMarkdown(env: Env, today = ''): Promise<{ markdown: string; facts: number }> {
  const res = await env.DB.prepare(
    `SELECT section, content, confidence, valid_from, valid_to, subject, predicate
     FROM memory_facts ORDER BY section, confidence DESC, valid_from DESC LIMIT 2000`,
  ).all<FactDocRow>();
  const rows = res.results ?? [];
  return { markdown: renderFactsDoc(rows, today), facts: rows.length };
}

/** 重建并落盘到 R2 facts.md（每晚归档后调用）。 */
export async function rebuildFactsDoc(env: Env, today = ''): Promise<{ facts: number; bytes: number }> {
  const { markdown, facts } = await buildFactsDocMarkdown(env, today);
  await putObject(env, 'facts.md', markdown, { contentType: 'text/markdown' });
  return { facts, bytes: new TextEncoder().encode(markdown).byteLength };
}
