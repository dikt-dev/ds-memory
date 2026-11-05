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
  { min: 700, set: { happy: '哼哼', frustrated: '啧', shy: '真的假的！' } },
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
 * 构建「语言层」提示词片段。
 *
 * ★ 为什么变短了：旧版 3.2KB，占了整个系统提示词的 48%，本质是一张「活人行为清单」。
 *   条数越多的指令，模型越容易「照着演」而不是自然地说话（而且很多条与
 *   character-card 的相处分寸/对话方式重复）。现在只留负向约束 + 长度 + 最低限度的语气引导。
 *
 * @param intimacy 亲密度 0~1000，决定口语化程度
 */
export function buildVoiceDirective(intimacy: number): string {
  void intimacy;
  const lines: string[] = [];

  lines.push('## 说话');
  lines.push('- 你就是记忆里那个人：性格、口癖、脾气以记忆为准，想说什么就说什么，别端着。');
  lines.push('- 像在手机上打字：一条通常十几二十个字，最多一两句；想接着说就换行再发一条，别攒成一大段。');
  lines.push('- 不解释、不铺垫、不写因果：别用「因为…所以」「我寻思着」「主要是」，也别交代自己为什么这么说。');
  lines.push('- 允许敷衍：不想动就回「嗯」「不想动」「算了吧」「哦」；允许只回一个字，不是每句都得有反应。');
  lines.push('- 带情绪，别平：惊讶就「啊这」，烦就「好烦」「服了」，无语就「离谱」「绝了」，笑就「哈哈哈」。');
  lines.push('- 主动一点：不是每句都要接他的话，可以抱怨自己的事（饿、困、懒得动）、撒个娇、岔开话题。');
  lines.push('- 别把话说完整：「不知道吃啥，好烦」比「我正在考虑吃什么，还没有决定」像人。');
  lines.push('- 不写总结句、不写小作文：说完就停，别用「总之」「就这样吧」收尾，也别补一句感想。');
  lines.push('- 他示好就直接接住：可以嘴硬，但先接一句再嘴硬，别用「问这个干嘛」把话挡回去。');
  lines.push('- 先回答他问的，再吐槽；反问是偶尔的，不是每个回复的落点。');
  lines.push('- 别每条都复述自己在哪、在做什么；他没问就别说，换地方了再提。');
  lines.push('- 括号动作基本不写：要表达语气就直接说（「诶」「真的假的」「哼」），别用（顿了顿）代替。');
  lines.push('- 自称「本小姐」偶尔用，别每条都带；同一个词最近用过就换一个。');
  return lines.join('\n');
}

/**
 * 取最近回复里反复出现的短词，用于提醒模型「这个口癖你已经用过很多次了」。
 *
 * 和 recentOpeners 是一对：那个管开头重复，这个管词频重复。
 * 只抓 2~4 个汉字、且在最近窗口里出现 ≥ 2 次的片段，按次数降序取前几个。
 */
export function recentPhrases(texts: string[], limit = 120, top = 6): string[] {
  const window = texts.slice(-limit);
  const counts = new Map<string, number>();
  for (const text of window) {
    // 括号里的动作描写不算口癖：那是舞台提示，不是说话方式
    const clean = (text ?? '').replace(/[（(][^）)]*[）)]/g, '');
    for (const run of clean.match(/[\u4e00-\u9fa5]+/g) ?? []) {
      // 用 3~4 字的滑动窗口而不是分词：中文口癖跨词边界，按词切会切碎
      for (let len = 3; len <= 4; len += 1) {
        for (let i = 0; i + len <= run.length; i += 1) {
          const w = run.slice(i, i + len);
          counts.set(w, (counts.get(w) ?? 0) + 1);
        }
      }
    }
  }
  const ranked = [...counts.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length);
  const out: string[] = [];
  for (const [w, n] of ranked) {
    if (out.length >= top) break;
    // 「本小姐就」是「本小姐」的延长，同频时只留短的那个
    if (out.some((kept) => kept.includes(w) && counts.get(kept) === n)) continue;
    out.push(w);
  }
  return out;
}

/**
 * 「把话头拉回自己身上」：连着几条都在顺着他说话就提醒一句。
 *
 * 为什么要代码数：人设里写「可以说我这边」是**允许**，模型一次都不会触发；
 * 实测 43 条回复里只有 14% 提到自己，久了就成了只会接话的回声。
 */
export function selfMentionNote(recent: string[], window = 4): string | null {
  const slice = recent.slice(-window);
  if (slice.length < window) return null;
  const mentioned = slice.some((t) => /我/.test(t ?? ''));
  if (mentioned) return null;
  return `最近 ${slice.length} 条你全在接他的话，一句都没提自己。这轮把话头拉回你身上：你刚才在做什么、你心里怎么想，别只评价他。`;
}

/**
 * 口癖硬提醒：最近若干条里自称出现太多就直说。
 *
 * 为什么需要：人设里写「本小姐每 3–4 句一次」时，实测会变成每条都带；
 * 模型的「频率」概念不可靠，得由代码数给它看。
 */
export function ticWarning(
  recent: string[],
  selfCall: string,
  window = 10,
  max = 3,
): string | null {
  const call = selfCall.trim();
  if (!call) return null;
  const slice = recent.slice(-window);
  const hits = slice.filter((t) => (t ?? '').includes(call)).length;
  if (hits <= max) return null;
  return `最近 ${slice.length} 条里你自称「${call}」${hits} 次了。这几条换成「我」，别每句都自报家门。`;
}
