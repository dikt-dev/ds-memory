/**
 * 人设文档（persona.md）：写在 R2 里的一段自由文本，与记忆完全分开。
 *
 * 为什么要分开：
 * - 提示词是"她是谁、怎么说话"——由人写，改一次要立刻生效，不该混在代码里；
 * - 记忆是"发生过什么"——由系统提炼、写入、检索，随时在变。
 *
 * 文档里的分区可以标「按需携带」：
 *
 *   <!-- when: 外貌|长相|照片|视频 -->
 *   ## 外貌
 *   ...
 *
 * 没有 when 注释的分区每轮都带；带 when 的只有用户这句话命中关键词才带。
 * 这样外貌、人际关系、旧事这类"平时不需要"的内容不会一直占上下文，
 * 但真被问到时又在场。
 */
const PERSONA_KEY = 'persona.md';

const WHEN_TAG = /<!--\s*when:\s*([^>]*?)-->/i;

export interface PersonaSection {
  /** 分区标题（没有标题的前言记作 ''） */
  title: string;
  /** 正文（含标题行） */
  body: string;
  /** 触发关键词；null = 常驻 */
  when: string[] | null;
}

function parseWhen(tag: string): string[] {
  return tag
    .split(/[|、,，\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 把文档切成若干分区，并识别每个分区的 when 触发词。 */
export function parsePersonaSections(doc: string): PersonaSection[] {
  const lines = doc.replace(/\r\n/g, '\n').split('\n');
  const sections: PersonaSection[] = [];
  let title = '';
  let body: string[] = [];
  let when: string[] | null = null;
  let pendingWhen: string[] | null = null;

  const flush = () => {
    const text = body.join('\n').trim();
    if (text) sections.push({ title, body: text, when });
    body = [];
  };

  for (const line of lines) {
    const tag = line.match(WHEN_TAG);
    if (tag) {
      // when 注释挂在下一次出现的 ## 标题上
      pendingWhen = parseWhen(tag[1]);
      continue;
    }
    if (line.startsWith('## ')) {
      flush();
      title = line.slice(3).trim();
      when = pendingWhen;
      pendingWhen = null;
      body = [line];
      continue;
    }
    body.push(line);
  }
  flush();
  return sections;
}

/**
 * 按用户这句话渲染人设：常驻分区全带，按需分区命中才带。
 *
 * @param doc      persona.md 原文
 * @param userText 用户这一轮说的话（空串表示没有可匹配的上下文，只带常驻分区）
 */
export function renderPersonaDoc(doc: string, userText: string): string {
  const text = doc.trim();
  if (!text) return '';
  const sections = parsePersonaSections(text);
  if (sections.length === 0) return text;
  const hay = (userText || '').toLowerCase();
  const kept = sections.filter((s) => {
    if (!s.when || s.when.length === 0) return true;
    return s.when.some((w) => hay.includes(w.toLowerCase()));
  });
  // 一个按需分区都没命中时，也不要只剩标题：至少保留常驻部分
  return stripDocNoise(kept.map((s) => s.body).join('\n\n'));
}

/**
 * 去掉文档里的「写作提示」，只留真正要说的话。
 *
 * 骨架里那些 <!-- 填什么 --> 和 > 开头的说明，是给人看的；
 * 原样塞进提示词，她会照着念，或者把"（待填充）"当成事实。
 */
function stripDocNoise(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, '')
    .split('\n')
    .filter(
      (line) =>
        !line.trim().startsWith('>') &&
        !/（\s*(待填充|按需|常驻)\s*）/.test(line) &&
        !/(骨架|待填充)/.test(line),
    )
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 取某个分区的正文（去掉标题行）。
 *
 * 用途：照片里「认不认得出自己」要读外貌卡；以前读的是环境变量，
 * 清空人设后那张卡填了也接不上。
 */
export function personaSectionText(doc: string, match: string): string {
  const sections = parsePersonaSections((doc || '').trim());
  const hit = sections.find((s) => s.title.includes(match) || (s.when ?? []).includes(match));
  if (!hit) return '';
  return hit.body
    .split('\n')
    .filter((line) => !line.startsWith('## '))
    .join('\n')
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim();
}

/** 读人设文档；没有就返回空串（回退到代码里的内置骨架）。 */
export async function loadPersonaDoc(env: { R2: R2Bucket }): Promise<string> {
  const obj = await env.R2.get(PERSONA_KEY).catch(() => null);
  if (!obj) return '';
  return (await obj.text()).trim();
}

/** 写入人设文档：后台编辑用。 */
export async function savePersonaDoc(env: { R2: R2Bucket }, text: string): Promise<number> {
  const body = text.trim();
  await env.R2.put(PERSONA_KEY, body);
  return new TextEncoder().encode(body).length;
}
