/**
 * 雷区与禁忌的主动学习。
 *
 * 思路：从对话中识别「用户表现出明显负面反应」的话题，累计证据后写入
 * memory.md 的「雷区与禁忌」分区，并在提示词里避免再踩。
 *
 * 为什么要累计而不是一次就记：
 * 一次情绪低落可能只是当天心情不好，不代表话题本身是雷区。
 * 只有同一类信号反复出现（或强度很高），才值得写进长期记忆。
 *
 * 判定流程：
 *   ① 扫描当天用户消息 → 提取负面信号（烦躁/拒绝/沉默/明确反感的表达）
 *   ② 找出触发上下文（哪句话之前用户是正常的，之后变负面）
 *   ③ 累积到 KV 的候选池（按关键词聚簇）
 *   ④ 达到阈值（≥2 次 或 强度极高）→ 写入 memory.md
 */

import type { Env } from './types';
import { ENTRY_RE } from './memory-maintenance';

/** 候选池 KV 键。 */
const CANDIDATE_KEY = 'aversion:candidates';
const CANDIDATE_TTL = 60 * 60 * 24 * 30; // 30 天

/** 写入雷区所需的最小累计次数。 */
export const AVERSION_THRESHOLD = 2;
/** 极强单次信号（直接写入，无需累计）。 */
export const AVERSION_STRONG_ONCE = true;

/**
 * 明确的负面反应词（比 mood.ts 更聚焦「反感」，不是「难过」）。
 * 这些词说明用户对**当前话题**不适，而不是单纯心情差。
 */
const AVERSION_WORDS: Array<{ word: string; weight: number }> = [
  // 明确拒绝 / 反感
  { word: '不想聊这个', weight: 3 },
  { word: '别问这个', weight: 3 },
  { word: '不想说', weight: 2 },
  { word: '换个话题', weight: 3 },
  { word: '别说这个', weight: 3 },
  { word: '不想提', weight: 2 },
  { word: '别提了', weight: 2 },
  { word: '算了不说', weight: 2 },
  // 不耐烦
  { word: '烦死了', weight: 2 },
  { word: '你有完没完', weight: 3 },
  { word: '别问了', weight: 2 },
  { word: '说了多少次', weight: 2 },
  // 难受 / 有阴影
  { word: '不想回忆', weight: 3 },
  { word: '有阴影', weight: 2 },
  { word: '当天就崩了', weight: 1 },
  { word: '心理阴影', weight: 2 },
  // 敷衍回避
  { word: '这个不重要', weight: 1 },
  { word: '没什么好说', weight: 1 },
];

/** 每个候选记录的结构。 */
export interface AversionCandidate {
  /** 触发反感的话题关键词（从上下文提取） */
  topic: string;
  /** 累计强度 */
  score: number;
  /** 命中次数 */
  count: number;
  /** 最近一次出现的日期 */
  lastDate: string;
  /** 原句（用于写入记忆时提供语境） */
  sample: string;
  /** 是否已写入记忆（防重复提升） */
  promoted?: boolean;
}

export interface AversionScanResult {
  /** 当天命中的信号 */
  hits: Array<{ topic: string; weight: number; sample: string }>;
  /** 当天总强度 */
  totalWeight: number;
}

/**
 * 从对话文本中提取「反感信号」。
 *
 * @param messages 当天用户消息（按时间顺序）
 */
export function scanAversions(messages: string[]): AversionScanResult {
  const hits: AversionScanResult['hits'] = [];
  let totalWeight = 0;

  for (let i = 0; i < messages.length; i++) {
    const text = (messages[i] ?? '').trim();
    if (!text) continue;

    for (const { word, weight } of AVERSION_WORDS) {
      if (!text.includes(word)) continue;
      // 话题从上一条用户消息里提取（用户通常先聊话题，再表达反感）
      const topic = extractTopic(messages[i - 1] ?? text);
      hits.push({ topic, weight, sample: text.slice(0, 40) });
      totalWeight += weight;
      break; // 一条消息只计一次最重信号
    }
  }

  return { hits, totalWeight };
}

/**
 * 从一条消息中提取「话题」关键词（用于聚簇）。
 *
 * 简化策略：取句子里最长的名词性片段。中文没有分词，这里用启发式：
 * - 去掉标点与语气词
 * - 取长度 2-10 的连续中文片段
 * - 优先返回出现频率最高的片段
 */
export function extractTopic(text: string): string {
  const cleaned = text
    .replace(/[，。！？、；：""''（）\s]/g, ' ')
    .replace(/[a-zA-Z0-9]+/g, ' ')
    .trim();
  if (!cleaned) return '';

  // 提取连续中文片段（2 字以上）
  const chunks = cleaned.match(/[\u4e00-\u9fa5]{2,10}/g) ?? [];
  if (chunks.length === 0) return '';

  // 过滤掉语气词和常见无意义词
  const STOP = new Set([
    '我们', '你们', '他们', '什么', '怎么', '这个', '那个', '就是', '可以',
    '不是', '没有', '还是', '但是', '而且', '所以', '如果', '因为', '然后',
    '感觉', '觉得', '知道', '时候', '现在', '今天', '明天', '昨天',
    '不想', '别说', '别问', '算了', '烦死', '换个', '话题',
    '知道了', '好的', '嗯嗯', '呵呵', '哈哈', '一下', '东西', '事情',
    '帮忙', '帮我', '给我', '跟你', '和你', '咱们', '一起',
  ]);
  const meaningful = chunks.filter((c) => !STOP.has(c) && !/^(嗯|啊|哦|呀|吧|呢|的|了|吗|嘛)+$/.test(c));
  if (meaningful.length === 0) return '';

  // 取最长的那个作为话题
  meaningful.sort((a, b) => b.length - a.length);
  return meaningful[0];
}

/** 读取候选池。 */
export async function loadCandidates(env: Env): Promise<AversionCandidate[]> {
  try {
    const raw = await env.KV.get(CANDIDATE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as unknown;
    return Array.isArray(arr) ? (arr as AversionCandidate[]) : [];
  } catch {
    return [];
  }
}

/** 保存候选池。 */
export async function saveCandidates(env: Env, list: AversionCandidate[]): Promise<void> {
  // 只保留最近 50 条，避免无限增长
  const trimmed = list.slice(-50);
  await env.KV.put(CANDIDATE_KEY, JSON.stringify(trimmed), { expirationTtl: CANDIDATE_TTL }).catch(() => {});
}

/**
 * 把当天扫描结果累积到候选池，返回「达到阈值、应当写入记忆」的条目。
 *
 * 防重复：已写入的条目用 promoted=true 标记，不再重复返回。
 */
export function accumulateCandidates(
  pool: AversionCandidate[],
  scan: AversionScanResult,
  today: string,
): { pool: AversionCandidate[]; promoted: AversionCandidate[] } {
  const next = pool.map((c) => ({ ...c }));
  const promoted: AversionCandidate[] = [];

  for (const hit of scan.hits) {
    if (!hit.topic) continue;
    const found = next.find((c) => c.topic === hit.topic);
    if (found) {
      found.score += hit.weight;
      found.count += 1;
      found.lastDate = today;
      found.sample = hit.sample;
    } else {
      next.push({
        topic: hit.topic,
        score: hit.weight,
        count: 1,
        lastDate: today,
        sample: hit.sample,
        promoted: false,
      });
    }
  }

  // 达到阈值且尚未写入过 → 提升
  for (const c of next) {
    if (c.promoted) continue;
    const meetsCount = c.count >= AVERSION_THRESHOLD;
    const meetsStrong = AVERSION_STRONG_ONCE && c.score >= 3 && c.count >= 1;
    if (meetsCount || meetsStrong) {
      promoted.push({ ...c });
      c.promoted = true;
    }
  }

  return { pool: next, promoted };
}

/** 把雷区条目格式化成 memory.md 的一行。 */
export function formatAversionEntry(c: AversionCandidate): string {
  return `- [${c.lastDate}] 避免主动聊「${c.topic}」（用户明确表现出不适）`;
}

/**
 * 把雷区条目并入记忆文本的「雷区与禁忌」分区（去重）。
 */
export function mergeAversionEntries(memory: string, entries: string[]): string {
  if (entries.length === 0) return memory;
  const lines = memory.split('\n');
  const headerIdx = lines.findIndex((l) => l.trim() === '## 雷区与禁忌');
  if (headerIdx === -1) return memory; // 没有该分区则不动（由 ensureModuleComments 补齐）

  // 找到该分区结束位置
  let endIdx = lines.length;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      endIdx = i;
      break;
    }
  }

  const sectionBody = lines.slice(headerIdx + 1, endIdx);
  const existing = sectionBody
    .filter((l) => ENTRY_RE.test(l))
    .map((l) => l.replace(/^-\s*\[\d{4}-\d{2}-\d{2}\]\s*/, '').trim());

  const toAdd: string[] = [];
  for (const e of entries) {
    const content = e.replace(/^-\s*\[\d{4}-\d{2}-\d{2}\]\s*/, '').trim();
    // 已存在同话题则不重复加
    if (existing.some((x) => x.includes(content) || content.includes(x))) continue;
    toAdd.push(e);
  }
  if (toAdd.length === 0) return memory;

  // 插到分区末尾（最后一个非空行之后）
  let insertAt = endIdx;
  while (insertAt > headerIdx + 1 && lines[insertAt - 1].trim() === '') insertAt -= 1;
  lines.splice(insertAt, 0, ...toAdd);

  return lines.join('\n');
}
