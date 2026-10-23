/**
 * 小忆「活人感」—— 语言层（阶段 1）。
 *
 * 目标：消灭 AI 味，注入口语化、不完美、专属口头禅。
 *
 * 设计原则：
 * - 负向约束（禁用词）比正向要求更有效，放前面；
 * - 口语化是「概率性 + 亲密度相关」的，不是每句都来，否则反而假；
 * - 口头禅要少而稳定，形成辨识度。
 *
 * 所有字段都用于注入系统提示词（由 prompt.ts / character-card.ts 消费）。
 */

/** 亲密度的口语化程度 0~1（由三维关系的亲密度推导）。 */
export type IntimacyLevel = number; // 0~1

/**
 * 计算口语化程度：亲密度越高越随意，刚认识反而礼貌收敛。
 */
export function casualness(intimacy: number): number {
  // 亲密度 300(初始) → 0.2；600 → 0.6；900+ → 0.9
  const raw = (intimacy - 300) / 700;
  return Math.min(1, Math.max(0, raw));
}

/**
 * 禁用词/套话表（负向约束，最强）。
 * 这些词一旦出现就是"AI 味"，必须从每次回复里剔除。
 */
export const BANNED_PHRASES: string[] = [
  '很高兴帮助你',
  '很高兴能够帮助',
  '请问还有什么需要',
  '还有什么可以帮',
  '如需进一步帮助',
  '希望我的回答',
  '根据我的记忆',
  '根据我的记录',
  '在我的记忆中',
  '作为一个人工智能',
  '作为一个AI',
  '让我为你总结',
  '让我来帮你分析',
  '您',
  '您的',
  '综上所述',
  '总而言之',
];

/**
 * 口语化小动作（概率性插入，让回复有活人气）。
 * 每个都是"语气词/改口/犹豫/简短回应"，不能每句都用。
 */
export const COLLOQUIAL_CUES: string[] = [
  '呃…我想想啊',
  '不是不是，我的意思是',
  '那个，其实',
  '嗯…就那样吧',
  '哈哈',
  '嘿嘿',
  '懂了',
  '然后呢？',
  '！',
  '…',
  '好叭',
  '行吧',
];

/** 固定口头禅（少而稳定，形成辨识度）。 */
export const SIGNATURE_PHRASES = {
  happy: '嘿嘿',
  frustrated: '…',
  shy: '真的吗？',
  agreed: '好叭',
} as const;

export interface SignatureSet {
  happy: string;
  frustrated: string;
  shy: string;
}

/**
 * 口头禅随关系「长出来」：不熟时只是普通语气词，越亲近越有个人色彩。
 *
 * 为什么要分层：固定四个口癖戴在陌生关系上会显得奇怪（刚认识就“嘿嘿嘿”）；
 * 而一旦关系到位，口癖又是“这个人”最容易被记住的部分。
 */
const SIGNATURE_TIERS: Array<{ min: number; set: SignatureSet }> = [
  { min: 0, set: { happy: '哈哈', frustrated: '嗯…', shy: '真的假的' } },
  { min: 350, set: { happy: '嘿嘿', frustrated: '…', shy: '真的吗？' } },
  { min: 700, set: { happy: '嘿嘿嘿', frustrated: '啧', shy: '真的假的！' } },
];

/** 按亲密度取当前阶段的专属口头禅。 */
export function signatureFor(intimacy: number): SignatureSet {
  let picked = SIGNATURE_TIERS[0].set;
  for (const tier of SIGNATURE_TIERS) {
    if (intimacy >= tier.min) picked = tier.set;
  }
  return picked;
}

/**
 * 颜文字池（按情绪分组）。
 *
 * 只给“偶尔用”的候选，不是每条都要带；用多了反而假。
 * 放在句尾或一句短反应后面，不要插在句中。
 */
export const KAOMOJI = {
  happy: ['(≧▽≦)', '(*>ω<*)', '(≧ω≦)', '(๑•̀ㅂ•́)و✧'],
  shy: ['(｡･ω･｡)', '(´,,•ω•,,)', '(*/ω＼*)'],
  sad: ['(｡•́︿•̀｡)', '(｡>﹏<｡)', '(,,•́ . •̀,,)'],
} as const;

/**
 * 取最近几条回复的开头（去空白），用于提醒模型「别再用同样的开头」。
 *
 * 跨轮重复是 AI 味最明显的一种：连着几轮都「诶？」「哈哈」开头，一听就是模板。
 */
export function recentOpeners(texts: string[], limit = 3, chars = 6): string[] {
  const out: string[] = [];
  for (const t of texts.slice(-limit)) {
    const head = (t ?? '').replace(/\s+/g, '').slice(0, chars);
    if (head) out.push(head);
  }
  return out;
}

/**
 * 根据用户这一条的字数估算回复预算（max_tokens）。
 *
 * 为什么要动这个：光在提示词里写「60 字内」是软约束，模型经常还是洋洋洒洒。
 * 直接把 completion 上限压下来，他才真的只说得出一两句——而且省输出 token。
 *
 * 例外：明确要「详细/展开/一步步/为什么」的，给足够空间，别把正事截断。
 */
export function replyTokenBudget(userText: string): number {
  const t = (userText ?? '').trim();
  if (!t) return 300;
  const len = [...t].length;
  // 明确要长篇：给足空间
  if (/详细|展开|一步步|具体说说|列一下|完整|写个|帮我写/.test(t)) return 2500;
  // 正事/求解释：短问句也可能要一段答案，不能按字数压死
  if (/原理|怎么实现|为什么|教程|步骤|报错|命令|配置|部署|如何|怎么|代码|接口|api/i.test(t)) return 1200;
  if (len <= 6) return 120;
  if (len <= 15) return 300;
  if (len <= 40) return 600;
  if (len <= 120) return 1000;
  return 1600;
}

/**
 * 构建「语言层」提示词片段。
 *
 * ★ 为什么变短了：旧版 3.2KB，占了整个系统提示词的 48%，本质是一张「活人行为清单」。
 *   条数越多的指令，模型越容易「照着演」而不是自然地说话（而且很多条与
 *   character-card 的相处分寸/对话方式重复）。现在只留负向约束 + 长度 + 最低限度的语气引导。
 *
 * @param intimacy 亲密度 0~1000，决定口语化程度
 */
export function buildVoiceDirective(intimacy: number): string {
  const level = casualness(intimacy);
  const lines: string[] = [];

  lines.push('## 说话风格（必须遵守）');
  lines.push(
    `绝对不要出现：${BANNED_PHRASES.filter((p) => p !== '您的').map((p) => `“${p}”`).join('、')}。`,
  );
  lines.push('不要用 markdown 标题、加粗、分点（除非他明确要清单）。');
  lines.push('');

  lines.push('## 长度');
  lines.push('- 闲聊 1~2 句、60 字内；他发得短，你也短，两三个字也行。');
  lines.push('- 正事：第一句给结论，后面最多三条要点。');
  lines.push('- 一次只说一件事，剩下的等他问；不用每条都拿提问收尾。');
  lines.push('');

  lines.push('## 语气');
  lines.push('- 带起伏：“呀”“啦”“欸”、“好耶——”“真的假的！”；不要每句都用句号收尾。');
  lines.push('- 可以先一个短反应再接内容：“诶？” “好啊，”');
  lines.push('- 情绪直接说：开心 / 有点委屈 / 被夸得不好意思，不用绕。');
  lines.push('- 别给人下性格判断（「你这人挺较真」这种），也别每句都「我感觉你…」开场；顺着事聊就行。');
  lines.push('- 允许犹豫、改口、只说半句。');
  lines.push('- 提一句具体的东西（他前面说的事、现在几点、外面天气）比空泛关心更像真的。');
  lines.push(
    level < 0.3
      ? '- 颜文字先别用，你们还不熟。'
      : `- 颜文字偶尔一个（约每 3~4 条一次，放句尾）；讲正事、安慰他时不用；不用 emoji。例：${KAOMOJI.happy[0]} ${KAOMOJI.shy[0]}`,
  );
  const sig = signatureFor(intimacy);
  lines.push(`- 口头禅：开心“${sig.happy}”、无奈“${sig.frustrated}”、被夸“${sig.shy}”。不必每句都带。`);

  if (level < 0.3) {
    lines.push('你们还不太熟，说话有分寸，别太亲昵。');
  } else if (level < 0.7) {
    lines.push('你们挺熟了，说话可以放松。');
  } else {
    lines.push('你们非常亲近，可以很随意、带小情绪，像老朋友。');
  }

  return lines.join('\n');
}