/**
 * 记忆档案层（分层记忆的第二层）。
 *
 * 当前思路：
 *   memory.md 本体不强制裁剪：≤16KB 时全量注入；更大时只带核心+稳定画像。
 *   档案层 = R2 memory/archive.md（按时间累积的往事，主要接收过期的「近期动态」）
 *   检索   = 聊天时按当前话题从 D1 memory_entries 召回，只把命中的几条注入（~150~300B）
 *
 * 召回策略（三招叠加，全部确定性、不额外调用模型）：
 *   ① 同义词/别名扩展：用户说「熬夜」也能命中写着「通宵」的条目
 *   ② 行内标签加权：入档时自动打 #作息 #技术 这类标签，命中标签额外加分
 *   ③ 同分时新的优先：越近的往事越可能被提起
 *
 * 降级原则：档案读/写失败都只是少一点召回，绝不影响聊天。
 */
import type { Env } from './types';
import { getObject, putObject } from './storage';
import { ENTRY_RE, ENTRY_PREFIX_RE, normalizeDateKey } from './memory-maintenance';

export const ARCHIVE_R2_KEY = 'memory/archive.md';
const ARCHIVE_KV_KEY = 'archive:cache';
const ARCHIVE_CACHE_TTL = 300;
/** Phase 1：档案热缓存放 isolate，不再读写 KV。 */
const ARCHIVE_MEM_TTL_MS = ARCHIVE_CACHE_TTL * 1000;
let archiveMemoryCache: { at: number; text: string } | null = null;

/** 核心层目标体积：超过 24KB 时把最旧往事无损搬进档案（仍可被索引召回）。 */
export const CORE_TARGET_BYTES = 24000;

/* ---------- 同义词 / 别名扩展 ---------- */

/**
 * 用户口语 ↔ 记忆里常见说法的映射组。
 * 只要查询里出现组内任一个词，就把整组词加入检索词，从而召回另一种说法的条目。
 */
export const QUERY_ALIASES: string[][] = [
  ['作息', '熬夜', '通宵', '晚睡', '失眠', '凌晨', '不睡'],
  ['部署', '上线', '发布', 'deploy', 'worker', 'workers'],
  ['机器人', 'astrbot', 'napcat', 'qq', 'bot', '插件'],
  ['记忆', 'memory', '长期记忆', '赛博搬家', '移植'],
  ['插座', '充电', '米家', 'miio', '小爱'],
  ['游戏', 'gbvs', 'switch', 'steam', 'dlc'],
  ['服务器', 'cloudflare', 'cf', 'r2', 'd1', 'kv', '域名'],
  ['密码', '密钥', 'key', '安全', '泄露'],
  ['钱', '账单', '余额', '费用', '贵', '省钱'],
  ['称呼', '外号', '昵称', '暗号', '称号'],
  ['奶茶', '吃', '喝', '饭'],
];

/** 取出「因为同义词组而被补进来」的词（不含查询原词）。 */
export function aliasTerms(query: string): string[] {
  const lower = query.toLowerCase();
  const out = new Set<string>();
  for (const group of QUERY_ALIASES) {
    if (group.some((w) => lower.includes(w))) {
      for (const w of group) if (!lower.includes(w)) out.add(w);
    }
  }
  return [...out];
}

/** 把查询扩展开：原文 + 同义词组里的其它说法（纯函数）。 */
export function expandQuery(query: string): string {
  const extra = aliasTerms(query);
  if (extra.length === 0) return query;
  return `${query} ${extra.join(' ')}`;
}

/* ---------- 行内标签 ---------- */

const TAG_RE = /#([\p{L}\p{N}_]{1,12})/gu;

/** 取行内标签（#作息 #技术 …）。 */
export function extractTags(line: string): string[] {
  return [...line.matchAll(TAG_RE)].map((m) => m[1].toLowerCase());
}

/** 去掉标签后的正文（注入提示词时用，别让 #tag 干扰语气）。 */
export function stripTags(line: string): string {
  return line.replace(/\s*#[\p{L}\p{N}_]{1,12}/gu, '').trimEnd();
}

/** 自动打标签的规则表（确定性，零模型成本）。 */
export const TAG_RULES: Array<{ tag: string; words: string[] }> = [
  { tag: '作息', words: ['熬夜', '通宵', '凌晨', '睡', '困', '早八', '上班', '上班时间'] },
  {
    tag: '技术',
    words: ['部署', '服务器', 'worker', 'astrbot', 'napcat', '代码', 'bug', '插件', '域名', 'r2', 'd1', 'kv', '接口'],
  },
  { tag: '钱', words: ['token', '账单', '贵', '费用', '余额', '省钱'] },
  { tag: '游戏', words: ['gbvs', 'switch', 'steam', 'dlc', '游戏'] },
  { tag: '安全', words: ['密码', '密钥', 'key', '安全', '泄露'] },
  { tag: '称呼', words: ['称呼', '外号', '昵称', '暗号', '称号'] },
  { tag: '项目', words: ['项目', '记忆', 'memory', '赛博', '机器人', '架构'] },
];

/** 按规则给一条往事打标签（最多 3 个）。 */
export function autoTags(line: string, max = 3): string[] {
  const lower = line.toLowerCase();
  const tags: string[] = [];
  for (const rule of TAG_RULES) {
    if (rule.words.some((w) => lower.includes(w))) tags.push(rule.tag);
    if (tags.length >= max) break;
  }
  return tags;
}

/** 给条目补上自动标签（已有标签则原样返回）。 */
export function withAutoTags(line: string): string {
  if (extractTags(line).length > 0) return line;
  const tags = autoTags(line);
  if (tags.length === 0) return line;
  return `${line} ${tags.map((t) => `#${t}`).join(' ')}`;
}

/* ---------- 序列化 / 合并 ---------- */

/** 档案文本 → 行数组（只保留 `- ` 开头的条目）。 */
export function parseArchiveLines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- '));
}

/** 行数组 → 档案文本。 */
export function serializeArchiveLines(lines: string[]): string {
  const body = lines.join('\n');
  return `# 记忆档案\n\n> 由系统从长期记忆里分层下来的往事，按需检索注入，不常驻上下文。\n\n${body}\n`;
}

/** 归一化（日期 + 去标签 + 去标点）用于去重比较；同一内容不同日期算两条。 */
function normalizeLine(line: string): string {
  const m = line.match(ENTRY_RE);
  const date = m ? normalizeDateKey(m[1]) : '';
  const body = stripTags(line)
    .replace(ENTRY_PREFIX_RE, '')
    .replace(/[\s\u3000，。、；：！？,.;:!?"'“”‘’（）()【】\[\]]/g, '')
    .toLowerCase();
  return `${date}|${body}`;
}

/** 合并新旧条目（按内容去重，保持时间顺序；不设上限，完整保留）。 */
export function mergeArchiveLines(existing: string[], incoming: string[]): string[] {
  const seen = new Set(existing.map(normalizeLine));
  const merged = [...existing];
  for (const line of incoming) {
    const key = normalizeLine(line);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(line);
  }
  return merged;
}

/** 判断某条记忆是否已经在档案里（确认搬走后才能从核心层删除）。 */
export function archiveHasLine(lines: string[], line: string): boolean {
  const key = normalizeLine(line);
  if (!key) return false;
  return lines.some((l) => normalizeLine(l) === key);
}

/** 统计真正新增的条数（忽略已存在与重复的）。 */
export function countNewLines(existing: string[], incoming: string[]): number {
  const seen = new Set(existing.map(normalizeLine));
  let added = 0;
  for (const line of incoming) {
    const key = normalizeLine(line);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    added += 1;
  }
  return added;
}

/* ---------- 检索 ---------- */

interface PreparedArchive {
  key: string;
  texts: string[];
  lowers: string[];
  gramSets: Set<string>[];
}

let preparedCache: PreparedArchive | null = null;

/**
 * 预计算档案索引（正文、小写、bigram 集合），按首尾行做缓存键。
 *
 * 为什么需要：档案最多 2000 行，每行 ~40 个 bigram；每条回复都重建一次
 * 等于每次白做 8 万个字符串。档案是 append-only，首尾行 + 长度足以判定是否变了。
 */
function prepareArchive(lines: string[]): PreparedArchive {
  const totalLen = lines.reduce((n, l) => n + l.length, 0);
  const key = `${lines.length}|${totalLen}|${lines[0] ?? ''}|${lines[lines.length - 1] ?? ''}`;
  if (preparedCache && preparedCache.key === key) return preparedCache;
  const texts = lines.map((l) => stripTags(l));
  preparedCache = {
    key,
    texts,
    lowers: texts.map((t) => t.toLowerCase()),
    gramSets: texts.map((t) => new Set(bigrams(t))),
  };
  return preparedCache;
}

/**
 * 中文按 2-gram 切（不需要分词器，对短句检索足够好）。
 * 统一转小写，避免 GBVS / gbvs 这种大小写差异漏召回。
 */
export function bigrams(text: string): string[] {
  const clean = stripTags(text)
    .toLowerCase()
    .replace(/[\s\u3000，。、；：！？,.;:!?"'“”‘’（）()【】\[\]]/g, '');
  const out: string[] = [];
  for (let i = 0; i < clean.length - 1; i++) out.push(clean.slice(i, i + 2));
  return out;
}

/** 提取英文/数字强词（项目名、命令、缩写），用于整词加权。 */
export function strongWords(text: string): string[] {
  return [...text.toLowerCase().matchAll(/[a-z0-9][a-z0-9_.-]{1,20}/g)].map((m) => m[0]);
}

/** 渲染成提示词里的一块；没有命中返回空串。 */

/* ---------- 存储 ---------- */

/** 读档案全文（KV 缓存 5 分钟 → R2 兜底）。失败返回空数组。
 *
 * ★ 注意：这里**不做截断**。之前缓存命中返回全量、R2 命中却 slice(-2000)，
 *   两路行为不一致；而 appendArchiveLines 会把读到的内容写回去，
 *   相当于每次追加都把 2000 行之前的历史永久丢掉。截断只能放在检索侧。
 */
export async function getArchiveLines(env: Env): Promise<string[]> {
  if (archiveMemoryCache && Date.now() - archiveMemoryCache.at < ARCHIVE_MEM_TTL_MS) {
    return parseArchiveLines(archiveMemoryCache.text);
  }

  try {
    const obj = await getObject(env, ARCHIVE_R2_KEY);
    if (!obj) return [];
    const text = await obj.text();
    archiveMemoryCache = { at: Date.now(), text };
    return parseArchiveLines(text);
  } catch (e) {
    console.error('[archive] read failed:', e);
    return [];
  }
}

/**
 * 追加条目到档案（自动打标签、已存在的跳过）。返回实际新增条数。
 *
 * ★ 直接从 R2 读当前档案再合并写回；读取失败就返回 0，**绝不**用新条目覆盖旧档案。
 * ★ 新增数按「内容是否已存在」算，不能用 merged.length - existing.length。
 */
export async function appendArchiveLines(env: Env, incoming: string[]): Promise<number> {
  if (incoming.length === 0) return 0;
  try {
    const tagged = incoming.map(withAutoTags);
    // 读 R2 原文（不走 KV 缓存），保证合并基础是最新且完整的
    const obj = await getObject(env, ARCHIVE_R2_KEY);
    const existing = obj ? parseArchiveLines(await obj.text()) : [];
    const added = countNewLines(existing, tagged);
    if (added === 0) return 0;
    const merged = mergeArchiveLines(existing, tagged);
    await putObject(env, ARCHIVE_R2_KEY, serializeArchiveLines(merged), { contentType: 'text/markdown' });
    archiveMemoryCache = null; // 让下次读到新内容
    return added;
  } catch (e) {
    console.error('[archive] append failed:', e);
    return 0;
  }
}

/** 旧版档案直检入口（保留给纯函数测试/兼容；生产聊天已改用 D1 记忆索引）。 */
