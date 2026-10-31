/**
 * 记忆主体守卫（用户反馈：有时候她把我做的事记成她做的）。
 *
 * 根因不在读取，在写入端的压缩：归档提示词要求「电报体、去主语」，
 * 「用户熬夜调通了 AstrBot」被压成「熬夜调通 AstrBot」，主体就丢了。
 * 丢了主体的句子再被注入提示词，模型会默认用第一人称读——变成她的经历。
 *
 * 这里做两件事，都不改记忆内容本身：
 *   1. classifyActor：把一条记忆判成「用户做的 / 她做的 / 一起做的 / 说不清」；
 *   2. auditSubjects：把「说不清 + 含动作」的条目挑出来，交给自检和管理端报给人看。
 *
 * 故意不动记忆：主体判断涉及事实归属，误改比漏改更糟。
 */
export type Actor = 'user' | 'assistant' | 'joint' | 'unclear';

/** 第一人称/第三人称指代她的词。 */
const SELF_WORDS = ['她', '我', '助手', '小忆'];
/** 指代用户的词。 */
const USER_WORDS = ['用户', '你', '他'];
/** 双方都参与的标记。 */
const JOINT_WORDS = ['一起', '我们', '共同', '陪', '互相', '彼此'];

/** 动作动词：出现这些词，这条记忆就有「谁做的」问题；静态事实没有。 */
const ACTION_VERBS = [
  '做', '写', '改', '调试', '调通', '修', '装', '买', '点', '吃', '喝', '跑', '部署',
  '提交', '实现', '搭', '建', '测', '试', '整理', '找', '查', '问', '说', '教', '讲',
  '发', '给', '拿', '放', '删', '重装', '刷机', '熬夜', '陪', '劝', '催', '建议', '指出',
];

function hasAny(text: string, words: string[]): boolean {
  return words.some((w) => text.includes(w));
}

/** 含动作动词才算「有主体问题」的句子。 */
export function isActionEntry(content: string): boolean {
  return hasAny(content, ACTION_VERBS);
}

/**
 * 判断一条记忆的主体。
 *
 * 优先级：显式「用户/你」> 显式「她/我/助手」> 「一起/我们」> 说不清。
 * 同时出现用户词和自身词时判 joint——因为这类条目通常两者都参与，
 * 强行二选一会制造新的错记。
 */
export function classifyActor(content: string): Actor {
  const text = content.trim();
  if (!text) return 'unclear';
  const user = hasAny(text, USER_WORDS);
  const self = hasAny(text, SELF_WORDS);
  if (user && self) return 'joint';
  if (user) return 'user';
  if (self) return 'assistant';
  if (hasAny(text, JOINT_WORDS)) return 'joint';
  return 'unclear';
}

export interface SubjectIssue {
  section: string;
  line: string;
  actor: Actor;
  /** 为什么被挑出来。 */
  reason: string;
}

const SECTION_RE = /^##\s+(.+)$/;
const ENTRY_RE = /^-\s*(?:\[(?:\d{4}|\d{2})-\d{2}-\d{2}\]\s*)?(.+)$/;

/**
 * 扫一遍 memory.md，挑出「动作条目但主体说不清」的行。
 *
 * 只扫非核心区：人物底色/称呼关系/雷区/用户更正由系统保护，不参与判断。
 */
/**
 * 这些分区不需要主体：核心区由系统保护；「关于用户」「偏好与习惯」整节默认主语就是用户。
 */
const DEFAULT_SKIP_SECTIONS = new Set([
  '人物底色',
  '称呼与关系',
  '雷区与禁忌',
  '用户更正（最高优先级）',
  '关于用户',
  '偏好与习惯',
]);

export function auditSubjects(
  text: string,
  coreSections: Set<string> = DEFAULT_SKIP_SECTIONS,
): SubjectIssue[] {
  const issues: SubjectIssue[] = [];
  let section = '';
  for (const raw of text.split(/\r?\n/)) {
    const header = SECTION_RE.exec(raw.trim());
    if (header) {
      section = header[1].trim();
      continue;
    }
    if (!section || coreSections.has(section)) continue;
    const m = ENTRY_RE.exec(raw.trim());
    if (!m) continue;
    const content = m[1].trim();
    if (!content) continue;
    // 键=值 是静态事实，不需要主体
    if (/^[^=＝\n]{1,16}[=＝]/.test(content)) continue;
    if (!isActionEntry(content)) continue;
    const actor = classifyActor(content);
    if (actor !== 'unclear') continue;
    issues.push({
      section,
      line: content,
      actor,
      reason: '含动作但没有主体（没写清是你做的还是她做的），注入时容易被读成她的经历',
    });
  }
  return issues;
}

/**
 * 给「说不清」的条目提一个改法：默认归给用户。
 *
 * 依据：她只能记自己「说过/想过/感受过」，凡是有外部动作、又没写主体的，
 * 多半用户在做的时候她在旁边看。归给用户比归给自己错得少。
 */
export function suggestRewrite(line: string): string {
  // 「[进行中] xxx」这种带状态标签的，主语要插在标签后面，否则格式就坏了。
  const m = /^(\[[^\]]{1,6}\]\s*)([\s\S]*)$/.exec(line);
  if (m) return `${m[1]}用户${m[2]}`;
  return `用户${line}`;
}
