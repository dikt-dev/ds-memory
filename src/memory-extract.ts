/**
 * 从用户消息里抽取高置信度事实（Phase 2B）。
 *
 * 只认显式自述，不做开放式 LLM 抽取：
 * - 我住在X / 我叫X / 我的猫叫X / 我喜欢X / 我讨厌X / 我在做X / 我用的是X；
 * - 结果进入 memory_facts（origin=conversation），带 source_message_ids；
 * - 默认只影响 shadow/next，不改变 legacy 回复。
 */
import { autoTags } from './memory-archive';
import { factId, stableHash, type MemoryFact } from './memory-domain';

export interface ExtractedMessage {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  dateKey?: string;
  createdAt?: number;
}

interface Rule {
  re: RegExp;
  section: string;
  key: string;
  /** 取第几个捕获组作为 object；默认最后一个。 */
  group?: number;
}

const RULES: Rule[] = [
  { re: /我住在([^\s，。！？；]{2,16})/, section: '关于他', key: '城市' },
  { re: /我叫([^\s，。！？；]{1,12})/, section: '关于他', key: '名字' },
  { re: /我的(猫|狗|宠物)(?:叫|是)([^\s，。！？；]{1,16})/, section: '关于他', key: '宠物', group: 2 },
  { re: /我(?:喜欢|最爱)([^\s，。！？；]{1,20})/, section: '他的偏好', key: '喜欢' },
  { re: /我(?:讨厌|不喜欢)([^\s，。！？；]{1,20})/, section: '他的雷区', key: '讨厌' },
  { re: /我(?:在|正在)(?:做|写|搞|开发)([^\s，。！？；]{1,24})/, section: '进行中的事', key: '项目' },
  { re: /我用(?:的是|的)([^\s，。！？；]{1,24})/, section: '关于他', key: '工具' },
];

function clean(text: string): string {
  return text.replace(/【[^】]{0,40}】/g, ' ').replace(/\s+/g, ' ').trim();
}

function factDate(msg: ExtractedMessage): string {
  if (msg.dateKey && /^\d{4}-\d{2}-\d{2}$/.test(msg.dateKey)) return msg.dateKey;
  const ms = msg.createdAt ?? Date.now();
  return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/** 抽取显式自述事实；同一消息重复规则只保留一条。 */
export function extractFactsFromMessages(messages: ExtractedMessage[]): MemoryFact[] {
  const out: MemoryFact[] = [];
  const seen = new Set<string>();
  for (const msg of messages) {
    if (msg.role !== 'user') continue;
    const text = clean(msg.content).slice(0, 500);
    if (!text || text.length < 3) continue;
    const date = factDate(msg);
    for (const rule of RULES) {
      const match = text.match(rule.re);
      if (!match) continue;
      const raw = match[rule.group ?? match.length - 1];
      const object = (raw ?? '').trim().replace(/[。！？；，]+$/, '');
      if (!object || object.length < 1) continue;
      const content = `${rule.key}=${object}`;
      const id = factId(rule.section, date, content);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        section: rule.section,
        content,
        subject: rule.key,
        predicate: rule.key,
        object,
        validFrom: date,
        validTo: null,
        confidence: 0.6,
        sourceMessageIds: [msg.id],
        tags: autoTags(content, 3),
        contentHash: stableHash(content),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
  }
  return out;
}
