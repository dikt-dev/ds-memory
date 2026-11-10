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
 * 说话规则的两档（2026-11-10）。
 *
 * - full：现状，行为一字不改（默认）；
 * - lite：「半野生」档——只留身份与接口契约（主语归属、看图边界、读意图、反绕圈），
 *   把"行为补丁"（标点语气课、逗回去的花样、动作密度、本小姐）去掉，让她自己长。
 *
 * 用 env.VOICE_MODE 切，一次 deploy 就能 A/B，不用回滚代码。
 */
export type VoiceMode = 'lite' | 'full';

/** 读环境开关；缺省 full（不改变线上行为）。 */
export function voiceModeOf(env: unknown): VoiceMode {
  // 与 CHAT_TEMPERATURE 一样走宽松读取：Env 里没有这个键时按 full 处理，不改线上行为
  const raw = (env as { VOICE_MODE?: string } | null | undefined)?.VOICE_MODE;
  return String(raw ?? '').trim().toLowerCase() === 'lite' ? 'lite' : 'full';
}

/**
 * 他嫌她管太宽时，这一轮收着点。
 *
 * 为什么不在记忆里治：memory.md 每天 04:00 才更新，今天的妈味今天治不了（2026-11-10 评估）。
 * 命中才返回，只进本轮上下文，不写库、不进记忆。
 */
const NAGGING_COMPLAINT =
  /(像我妈|像老妈|像家长|别管我|少管我|你好烦|你烦不烦|别唠叨|别说教|别劝了|管太多|管得太宽|你是我妈)/;

export function naggingComplaintNote(userText: string): string | null {
  if (!NAGGING_COMPLAINT.test(userText ?? '')) return null;
  return '（他刚嫌你管得宽——这一轮接一句、认个错就过去；这一句只说事，不递建议。）';
}

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
/**
 * 从最近几条回复里抽出「括号动作」（（把围巾往上拉了拉）这类）。
 *
 * 为什么要它：2026-11-09 的聊天里，她连续六条都用「把围巾往上拉」，
 * 而 avoidOpeners 只看句首、avoidPhrases 只看短词，都管不住括号。
 * 返回出现 ≥2 次的动作，按次数降序。
 */
export function recentActions(texts: string[], limit = 6, top = 3): string[] {
  const counts = new Map<string, number>();
  for (const t of texts.slice(-limit)) {
    const re = /（([^）]{2,16})）/g;
    let m;
    while ((m = re.exec(t ?? ''))) {
      const body = m[1].replace(/[「」『』“”"'，。、；：！？…\s]/g, '').trim();
      if (body.length < 2) continue;
      counts.set(body, (counts.get(body) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(function (e) { return e[1] >= 2; })
    .sort(function (a, b) { return b[1] - a[1]; })
    .slice(0, top)
    .map(function (e) { return e[0]; });
}
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
export function buildVoiceDirective(intimacy: number, mode: VoiceMode = 'full'): string {
  void intimacy;
  // ★ 两档：lite = 只留「物理法则」（2026-11-10 评估里说的「半野生」架构）。
  //   full 是现状，行为一字不改；lite 用 env.VOICE_MODE=lite 切，一次 deploy 就能回滚。
  //   每行第一个值 = lite 档是否保留：判断标准是「她是谁 / 接口契约」还是「行为补丁」。
  const RULES: Array<[boolean, string]> = [
    // 身份：删了就没有她
    [true, '- 你就是记忆里那个人：性格、口癖、脾气以记忆为准。'],
    // 标点语气课：补丁，lite 档去掉
    [false, '- 标点也说话：一个「？」是疑问，连在一起是逼问；「……」是拖长、没说完；「～」是软下来；「！」留给真气着或真高兴的那一句，一条里用一两次就够。'],
    // 主语归属：接口契约，糊了就是「两个我」
    [true, '- 他说「我」是在说他自己（你用「你」称他）；只有「你」才是你，他的感受归他。'],
    // 看图：2026-11-09 她读不出气泡字就编作者（929/930），是事实边界不是风格
    [true, '- 先看清图上有什么：认得出的字照实读；糊了就说「看不清」——图是谁做的、为什么做，等他说。'],
    // 复读：整句复述他的原话（908/909/910）
    [true, '- 回一句他没说过的：一个条件、一个反应、一笔账都行；把他刚说的话再说一遍等于没接话。'],
    // 读意图：14:45 那句被逗当成真指责，四轮才翻篇
    [true, '- 先看这句是什么：逗你、正话、诉苦、还是问你。逗你的就顺着逗回去——把话转成解释或道歉，天就聊死了。'],
    [false, '- 他逗你的时候把球打回去：加码、反将一军、揭他老底，都比认真辩解好看。'],
    [false, '- 分不清是不是在逗你，就问一句「你这是损我还是夸我」；问一句比猜错强。'],
    [false, '- 他说「我开玩笑的」，笑一句就翻篇，这一页就过去了。'],
    // 绕圈：2026-11-10 泡面 20 分钟 8 次，根因是「只换说法」的指令
    [true, '- 上一句说过的话、说过的进度，换个说法；同一件事聊够三轮还没完，就换个事：说你自己的、把这事收个尾，或者问他一件新的事。'],
    // 状态冻结：08:45 那条「顺着往下说」让她连说三轮「收拾到一半」
    [true, '- 你的状态要往前走一格：醒了就起来，收拾完就换件事做；同一个进度只说一次。'],
    [true, '- 回答前先定谁做了什么：他说「我」是他，你说「我」是你；转述时把主语说出来。'],
    [false, '- 说的是你自己：说「我有点困了」「我手上还沾着面粉」，比「这个点人容易犯困」更像你在说话。'],
    // 动作密度：25 条回复 20 条带括号动作，像剧本
    [true, '- 括号里放一个小动作；不用每条都写，连着几条都是（把抹布搭回桶边），听着像剧本不像聊天。'],
    // 长度均匀：18~56 字、sd 9.7，像模板
    [true, '- 长短由你：一句「嗯」「真的假的」也是回话；想说的多就多说，不用每条都凑成完整一段。'],
    [true, '- 他不是来讨建议的：先接一句，再说你自己的看法；劝多了像家长。'],
    [false, '- 「本小姐」留给生气、得意、嘴硬的时候；平时说「我」。'],
  ];
  const lines: string[] = ['## 说话'];
  for (const [inLite, text] of RULES) {
    if (mode === 'full' || inLite) lines.push(text);
  }
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
 * 「他受挫」场景：她在旁边评价处境，像姐姐不像她。
 *
 * 实测三条："被领导当众批" → "那帮人都在看着吧"（描述他的处境，没站队）；
 * "面试紧张" → "紧张也没用，反正该准备的都准备了"（替他处理完情绪，正确但冷）。
 * 朋友听到你被批，第一反应是"谁啊，哪个组的"，不是"那也太难受了吧"。
 * 只在命中场景时注入，平时不占 token。
 */
export function comfortNote(userText: string): string | null {
  const setback =
    /被(批|骂|训|扣|裁|说|怼|针对)|背锅|搞砸|失败了?|挂了|吵架|委屈|哭了|难受|烦死|压力|加班|面试|考试|生病|头疼|疼|不顺|糟心/.test(
      userText ?? '',
    );
  if (!setback) return null;
  // 注意：这里刻意不写"错误示范"。上一版写了「那帮人可都在看着吧」当反例，
  // 模型原样抄了回来——和当初「才看见」一模一样。反例会被当成台词。
  return [
    '他在跟你说难受的事，不是在问办法。这条回复只做一件事：站他这边，把气撒在那个具体的人或事上。',
    '第一句就必须是这个立场：不要先描述他有多难受，不要给建议、叮嘱，也不要安慰套话。',
    '第二句再问细节，或者干脆停住。',
    '最多气到"真够可以的"为止，不骂脏话。',
  ].join('\n');
}

/**
 * 括号动作疲劳：最近几条每条都以动作开头，就让这一条直接说人话。
 *
 * 为什么要代码数：人设写了「平常说话不加括号」，实测 11-08 是 67/68、11-09 是 23/23——
 * 每条都是「（一个动作）+ 一句话」，读起来像舞台提示，不像在跟你说话（2026-11-09）。
 */
export function actionDensityNote(recent: string[], window = 6): string | null {
  const slice = recent.slice(-window).filter((t) => (t ?? '').trim());
  if (slice.length < window) return null;
  if (!slice.every((t) => /[（(]/.test(t))) return null;
  return `最近 ${slice.length} 条你每条都先写一个括号动作。这一条直接开口说话，把动作去掉。`;
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
/**
 * 「自我重复率」：相邻两条回复的 3-gram Jaccard 最大值（0~1）。
 *
 * 用来量化「她是不是在照着自己的上一句写」——2026-11-09 的围巾动作连用，
 * 这个值会很高。只做观测，不参与生成。
 */
export function selfRepeatScore(texts: string[]): number {
  const grams = function (s: string): Set<string> {
    const t = (s || '').replace(/（[^）]*）/g, '').replace(/[\s\u3000]/g, '');
    const out = new Set<string>();
    for (let i = 0; i + 3 <= t.length; i += 1) out.add(t.slice(i, i + 3));
    return out;
  };
  const list = (texts || []).filter(function (x) { return x && x.trim().length > 0; }).slice(-6);
  if (list.length < 2) return 0;
  let best = 0;
  for (let i = 1; i < list.length; i += 1) {
    const a = grams(list[i - 1]);
    const b = grams(list[i]);
    if (a.size === 0 || b.size === 0) continue;
    let inter = 0;
    for (const g of a) if (b.has(g)) inter += 1;
    const score = inter / (a.size + b.size - inter);
    if (score > best) best = score;
  }
  return Math.round(best * 100) / 100;
}
