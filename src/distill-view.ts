/**
 * 提炼专用视图：把「当天对话」压成喂给模型的输入。
 *
 * 为什么需要：归档日志必须保原文（检索、回溯、逐字引用都靠它），
 * 但提炼只是要「今天发生了什么、记下什么」，不需要你粘贴的 8000 字任务表全文。
 * 实测 10-30：5 条消息占全部字数的 62%，其中 3 份粘贴的 .md 就有 2 万字。
 */
import { sanitizeMessagePlaceholders } from './db';

const FILE_BLOCK_RE = /【文件：([^】]+)】\s*```[a-zA-Z]*\n?[\s\S]*?```/g;
const FILE_MARK_RE = /【文件：([^】]+)】/g;
const ENTRY_RE = /^-\s*\[\d{2,4}-\d{2}-\d{2}\]/;
const HEADER_RE = /^#{2,3}\s/;

/**
 * 最长保留的用户正文。
 *
 * 之前 3000：理由是"再长基本是粘贴的文件/日志"。但文件块在上一步
 * collapseFileBlocks 已经折成一行了，这里再砍，砍掉的是用户真正的长叙述
 * （项目背景、回忆、需求细节——正是记忆该记的东西）。空间不要钱，放开。
 */
const USER_MAX_CHARS = 12000;
/**
 * 她的回复保留长度。
 *
 * 之前 400 是同一条思路的副作用：以为"记忆只记用户的事"，但「共同经历」
 * 记的是双方的反应，她的承诺/情绪/玩笑也是要留的。400 字连一段完整回复都放不下。
 */
const ASSISTANT_MAX_CHARS = 6000;

export interface DistillRow {
  role: string;
  content: string;
  turn_type?: string | null;
}

/** 把 fenced code block 换成字数说明，保留文件名。 */
export function collapseFileBlocks(content: string): string {
  return content
    .replace(FILE_BLOCK_RE, (_m, name: string) => `【文件：${name}】（正文已省略）`)
    .replace(FILE_MARK_RE, (_m, name: string) => `【文件：${name}】`);
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `…（后略 ${text.length - max} 字）`;
}

/** 一行一条：用户/助手 + 内容，主动消息单独标注。 */
export function buildDistillConversation(rows: DistillRow[]): string {
  return rows
    .map((row) => {
      const cleaned = collapseFileBlocks(sanitizeMessagePlaceholders(row.content ?? ''));
      // 标签和提炼提示词里的主语保持一致：他 / 你
      if (row.role === 'user') return `他：${clip(cleaned, USER_MAX_CHARS)}`;
      const text = clip(cleaned, ASSISTANT_MAX_CHARS);
      return row.turn_type === 'proactive'
        ? `你（主动发起，他没回）：${text}`
        : `你：${text}`;
    })
    .join('\n\n');
}

/**
 * 提炼结果 → 审计快照用的纯条目。
 *
 * 模型有时会顺手把「心情值：455 / 1000」这类派生行也抄进来，那不是记忆，
 * 写进审计文件后回看会跟真实关系值对不上，这里只留分区标题与记忆条目。
 */
export function sanitizeDistilledSummary(text: string): string {
  return text
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => HEADER_RE.test(line.trim()) || ENTRY_RE.test(line.trim()))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}