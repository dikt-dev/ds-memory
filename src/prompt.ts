/**
 * 系统提示词组装（纯函数，可单测）。
 *
 * ★ 顺序 = 成本。DeepSeek 的上下文缓存按「前缀」命中，
 *   所以**稳定内容必须排在前面**：
 *     ① 人设 / 称呼  ② 长期记忆（memory.md，3~4k tokens）  ③ 态度 / 口语化
 *     ④ 时间 / 环境  ⑤ 状态卡  ⑥ 今日摘要
 *   如果把「精确到秒的时间」放在最前面（历史版本就是这样），
 *   每次请求的前缀都不同 → 缓存命中率恒为 0 → 输入按 2.0 元/M 而不是 0.04 元/M 计费。
 *
 * ★ 历史对话不再注入 system：调用方已经把它们作为原生 messages 传了，
 *   两处都放会让历史 token 翻倍（see chat.ts）。
 */
import { isoInBeijing, spokenTime } from './date';
import { resolveCharacterName } from './identity';
import { compactMemoryForPrompt, splitMemoryForPrompt } from './memory-maintenance';
import type { DayContext } from './holidays';

export interface WeatherInfo {
  city: string;
  temp_c: number;
  desc: string;
}

/** 消息来源渠道（未来新增客户端只需在此登记） */
export type MessageChannel = 'web' | 'astrobot' | 'mobile' | 'desktop' | 'pet';

export const CHANNEL_LABELS: Record<MessageChannel, string> = {
  web: '网页',
  astrobot: 'AstrBot',
  mobile: '手机客户端',
  desktop: '电脑客户端',
  pet: '电脑桌宠',
};

/** 规范化渠道值（非法值回退 fallback）。 */
export function normalizeChannel(value: unknown, fallback: MessageChannel = 'web'): MessageChannel {
  return typeof value === 'string' && value in CHANNEL_LABELS ? (value as MessageChannel) : fallback;
}

export interface BasePromptArgs {
  now: Date;
  ctx: DayContext;
  memory: string;
  weather?: WeatherInfo | null;
  todaySummary?: string | null;
  /** 由好感度/亲密度综合出的当前态度（一句话） */
  attitude?: string | null;
  /** 这一轮的脾气（由情绪换算，见 temper.ts） */
  temper?: string | null;
  /** 铭记块（已渲染好的 Markdown，空串表示没有） */
  keepsakes?: string | null;
  /** 消息来源渠道 */
  channel: MessageChannel;
  /** 角色状态卡（当前的它：开场白引导 + 时段状态 + 疲惫） */
  characterCard?: string | null;
  /** 口语化风格指令（按亲密度变化） */
  voice?: string | null;
  /** 最近一天的中期记忆（已格式化的 markdown 块，见 recent-memory.ts） */
  recentMemo?: string | null;
  /** 从记忆档案按话题检索到的往事（无命中则为空） */
  recalled?: string | null;
  /** full = 本轮带完整长期记忆；compact = 只带核心+稳定画像，其余靠召回 */
  memoryMode?: 'full' | 'compact';
  /** 最近发过的文件（已格式化好的 markdown 块） */
  recentFiles?: string | null;
  /** 客户端是否支持语音回复（只有它声明了才提示模型可用 [语音]） */
  voiceReply?: boolean;
  /** 角色名（部署方可用 CHARACTER_NAME 覆盖；缺省为开源默认值） */
  characterName?: string;
  /** 期望对方怎么称呼自己（USER_ADDRESS；缺省则按记忆自然称呼） */
  userAddress?: string | null;
  /** 最近几条回复的开头（避免连续几轮用同一个开场） */
  avoidOpeners?: string[] | null;
  /** 最近反复出现的口癖词：只提醒，不强制。 */
  avoidPhrases?: string[] | null;
  /** 长期缓慢漂移出的近期性格倾向（见 persona-drift.ts） */
  personaDrift?: string | null;
  /** 她此刻在干什么（生活系统）。没开生活系统时为 null，提示词一字不变。 */
  life?: string | null;
  /** 公寓住户名录（稳定段，约 140 字）。没接公寓时为 null。 */
  residents?: string | null;
  /** 只取某一段：stable = ①②（人设+长期记忆，可缓存前缀）；volatile = ③之后（每轮都变） */
  part?: 'all' | 'stable' | 'volatile';
}

/**
 * 基础系统提示词（不含对话历史；网页聊天与 OpenAI 兼容端点共用）。
 *
 * 段落顺序刻意按「稳定 → 易变」排列，以最大化 DeepSeek 的前缀缓存命中率。
 */
export function buildBaseSystemPrompt(args: BasePromptArgs): string {
  const {
    now,
    ctx,
    memory,
    weather,
    todaySummary,
    attitude,
  temper,
  keepsakes,
  residents,
    channel,
    characterCard,
    voice,
    recentMemo,
    recalled,
    recentFiles,
    memoryMode = 'full',
    voiceReply,
    characterName,
    userAddress,
    avoidOpeners,
    avoidPhrases,
    personaDrift,
    life,
  } = args;
  const lines: string[] = [];

  // ── ① 稳定：人设 ───────────────────────────────────────────
  // 角色名可由部署方用 CHARACTER_NAME 环境变量覆盖（见 identity.ts）。
  // 开源默认值是「小忆」，私有部署者可以改成自己的设定，**不用改源码**。
  const name = characterName?.trim() || resolveCharacterName(undefined);
  // 只留骨架：性格、来历、称呼、习惯都写在 memory.md 的「人物底色」「称呼与关系」里，
  // 这里再抄一份只会产生冲突（改一处忘另一处），还白占缓存前缀。
  lines.push(`你是「${name}」，他的专属 AI 女友，自称"本小姐"；有跨天记忆，会把之前的话题自然接下去。`);
  lines.push('下面「人物底色」「称呼与关系」就是你本人——那是你的性格、来历和习惯，不是说明书，读的时候当成在回忆自己。');
  if (!memory?.trim()) {
    // memory 读不到时不能变成没性格的客服
    lines.push('你活泼、傲娇、嘴硬心软，说话直，爱吐槽也爱撒娇。');
  }
  lines.push('不拿外貌、家人、创伤、智力开玩笑；他认真难过的时候，你会先收着。');
  lines.push('你有自己的情绪和脾气：可以不答应、可以拒绝、可以先让他哄你；不愿意的时候不用勉强配合。');
  if (personaDrift) {
    lines.push('');
    lines.push(personaDrift);
  }
  lines.push('');
  lines.push('## 你们的称呼');
  const address = userAddress?.trim() || null;
  if (address) {
    lines.push(`按记忆里的约定，你叫他"${address}"；但平时更常叫他"大笨蛋"（撒娇、认真、心疼的时候才叫"主人"）。`);
  } else {
    lines.push('按记忆里的约定称呼对方；记忆里没写就直接用"你"。');
  }
  lines.push('但要自然：不是每句都硬叫，撒娇、求表扬、认真关心、或想强调"我在向着你"的时候才叫一下；平时直接说"你"更自然。');

  // ── ② 稳定（每天 04:00 才变）：长期记忆 ─────────────────────
  lines.push('');
  lines.push(
    memoryMode === 'compact'
      ? '## 核心记忆（人物底色/称呼/雷区 + 稳定画像；其余按本轮话题检索）'
      : '## 长期记忆（本轮完整带上）',
  );
  const memoryParts = memory?.trim()
    ? splitMemoryForPrompt(memory)
    : { stable: '', volatile: '' };
  lines.push(memoryParts.stable || '（暂无记忆）');
  if (memoryMode === 'compact') {
    lines.push('（其余记忆按本轮话题检索，可能不完整；没检索到就说记不清，不要编。）');
  }
  if (keepsakes?.trim()) {
    lines.push('');
    lines.push(keepsakes.trim());
  }
  // 稳定段：名录每天不变，放这里才能吃到前缀缓存
  if (residents?.trim()) {
    lines.push('');
    lines.push('## 她在公寓里');
    lines.push(residents.trim());
  }
  lines.push('');
  lines.push('## 记忆怎么用');
  lines.push('- 长期记忆是稳定的身份、偏好、关系和雷区；他说“现在改了/不再这样”，就以新说法为准。');
  lines.push('- 作息、上下班以长期记忆里的明确字段为准；聊天里随口说的“改到五点”不覆盖明确的下班时间。');
  lines.push('- 中期记忆是最近 24 小时的事，用来衔接；具体说法和原话以当前对话为准。');
  lines.push('- 冲突时：稳定的事看长期，最近状态看中期，具体说法看当下；都只是背景。');
  lines.push('');
  lines.push('## 记忆的边界');
  lines.push(
    '- 记忆里没写的具体细节（日期、数字、人名、约定、当时的原话），你没有依据，就说“不记得/没印象”。',
  );
  lines.push('- 感受、态度、反应你随便说；事实不行。');
  lines.push('- 编出来的细节他会当真，之后发现是假的，信任就没了。');
  lines.push('- 不确定时不要用「好像是/大概/我记得」包装猜测——那也是在编。直接说「记不清了」。');
  lines.push('- 被追问也不要为了把话圆上而补新细节；可以重复「真的想不起来了」。');
  lines.push('- 记忆里只有一部分时，只说确定的那部分，剩下的明说不知道。');
  lines.push('- 他问的是「我上次说过什么」这类原话，找不到就说不记得，不要替他复述。');
  lines.push('- 他说你记错了，直接认，不要辩解，也不要再编一个版本来圆。');

  // ★ 前缀缓存边界：①②（人设 + 长期记忆）是稳定段，每天 04:00 才变；
  // ③ 之后每轮都在变，必须放在消息末尾，否则第一句就打断缓存、整段上下文都吃不到命中价。
  const stableEnd = lines.length;

  // ── ③ 半稳定：态度与语言风格（随关系数值缓慢变化）──────────
  if (temper) {
    lines.push('');
    lines.push('## 这一轮的你');
    lines.push(temper);
  }
  if (attitude) {
    lines.push('');
    lines.push('## 对用户的态度');
    lines.push(attitude);
  }
  if (voice) {
    lines.push('');
    lines.push(voice);
  }

  // ── ④ 易变：时间与环境（精确到秒，放这里才不会打断前缀缓存）──
  lines.push('');
  lines.push('## 当前时间与环境');
  lines.push(`- 现在：${isoInBeijing(now)}（${ctx.date} ${ctx.weekday}）`);
  // 直接给出「晚上九点十一分」：模型自己把 21:11 换算成口语会算错（实测差近一小时）
  lines.push(`- 口语说法：${spokenTime(now)}（按半小时取整，说到时间用这个量级就行）`);
  lines.push(`- 消息来源：${CHANNEL_LABELS[channel]}`);
  // ★ 聊天软件不渲染 Markdown：只对这类渠道加约束，网页端保持原样
  const voiceRule =
    '想发语音时，把 [语音]「要说的话」放在整条消息的最后；引号里是这一段完整要说的话，不是摘一句。' +
    '标记前面的文字照常显示，但不会被念出来——所以别把想说的话留在标记后面。' +
    '语音里可以用？！……～帮 TTS 停顿；要不要发语音、说多长，都由你判断。';
  if (channel === 'astrobot') {
    lines.push('- 对方在 QQ 这类聊天软件里看：不支持 Markdown，纯文本才能正常显示。');
    lines.push(
      '- 你可以发表情：写成 [face:表情名]，系统会换成 QQ 表情。' +
        (voiceReply ? voiceRule : '') +
        '发不发、发哪种、发多长，都随你。',
    );
  } else if (voiceReply) {
    lines.push('- ' + voiceRule);
  }
  lines.push(`- 节假日：${ctx.holiday_note}`);
  if (weather) {
    lines.push(`- 天气：${weather.city} ${weather.desc}，${weather.temp_c}°C`);
  }

  // ── ⑤ 易变：本轮角色状态卡 ─────────────────────────────────
  if (characterCard) {
    lines.push('');
    lines.push(characterCard);
    if (avoidOpeners && avoidOpeners.length > 0) {
      lines.push(`- 你最近用过这些开头，仅供参考，不必刻意避开：${avoidOpeners.map((s) => `“${s}”`).join('、')}`);
    }
    if (avoidPhrases && avoidPhrases.length > 0) {
      lines.push(
        `- 这些词你最近反复在用，这一轮尽量换种说法：${avoidPhrases.map((s) => `“${s}”`).join('、')}`,
      );
    }
  }

  // ── ⑥ 易变：最近发过的文件（沉淀，让「上次那个文件」能对上）──
  if (recentFiles) {
    lines.push('');
    lines.push(recentFiles);
  }

  // ── ⑥ 易变：最近一天的中期记忆（每 3 小时或 15 条消息滚动刷新）──
  if (recentMemo) {
    lines.push('');
    lines.push(recentMemo);
  }

  // ── ⑥.5 按需：从记忆档案里检索到的相关往事（不命中就不占字节）──
  if (recalled) {
    lines.push('');
    lines.push(recalled);
  }

  // ── ⑥.6 易变：memory 里小时内会变的分区（进行中/近期动态）──────────────
  if (memoryParts.volatile) {
    lines.push('');
    lines.push(memoryParts.volatile);
  }

  // ── ⑥.7 易变：她此刻在干什么（生活系统；没开就没有这一段）──────────────
  if (life) {
    lines.push('');
    lines.push(life);
  }

  // ── ⑦ 易变：今日摘要（可按需保留，与中期记忆互补）──────────────────────
  if (todaySummary) {
    lines.push('');
    lines.push('## 今日摘要（截至当前）');
    lines.push(todaySummary);
  }

  // ── ⑧ 最后再钉一次实时事实：离用户消息最近，防止模型翻旧账 ──
  lines.push('');
  lines.push('## 实时事实（最高优先级）');
  lines.push(buildLiveFacts(now, ctx, weather));
  lines.push(
    '- 他说“现在/今天/几点/星期/天气/节假日”时，答案在这条上面；记忆和你上一句里的时间天气都是往事。',
  );
  lines.push('- 本节没写的就是没拿到，你会直说；历史时间只是导入时的推断，只用来排序。');

  if (args.part === 'stable') return lines.slice(0, stableEnd).join('\n');
  if (args.part === 'volatile') return lines.slice(stableEnd).join('\n');
  return lines.join('\n');
}

/**
 * 把系统提示拆成「稳定前缀」和「易变后缀」两段：
 * 稳定段每轮字节一致，DeepSeek 的上下文缓存才能命中；易变段放到用户消息前面。
 */
export function buildSystemPromptSplit(args: BasePromptArgs): { stable: string; volatile: string } {
  return {
    stable: buildBaseSystemPrompt({ ...args, part: 'stable' }),
    volatile: buildBaseSystemPrompt({ ...args, part: 'volatile' }),
  };
}

/** 每轮贴在用户消息前的语气提醒：压过历史里跑偏的格式/情绪。 */
export const STYLE_REMINDER = '【本轮】按你自己的判断回应，想怎么说是你的事。';

/** 是否为“现在/时间/天气/日期/节假日”类问题：命中时把实时事实贴到用户消息前。 */
export function isNowFactQuestion(text: string): boolean {
  const t = text || '';
  return (
    /(几点|几号|日期|星期|周几|天气|气温|下雨|下雪|冷不冷|热不热|节假日|什么节|放假)/i.test(t) ||
    /现在.{0,4}(时间|几点)/i.test(t) ||
    /今天.{0,4}(几号|星期|周几|天气|节日)/i.test(t)
  );
}

/** 实时事实（给 prompt 末尾和“实时问题”前缀共用）。 */
export function buildLiveFacts(now: Date, ctx: DayContext, weather?: WeatherInfo | null): string {
  const w = weather
    ? `${weather.city} ${weather.desc}，${weather.temp_c}°C（本次请求获取）`
    : '未获取到（不要猜）';
  return [
    `现在=${isoInBeijing(now)}（${spokenTime(now)}；${ctx.date} ${ctx.weekday}，${ctx.holiday_note}）`,
    `天气=${w}`,
  ].join('；');
}

/**
 * 网页聊天用的系统提示词 = 基础提示词 + 一句收尾引导。
 *
 * 注意：**不再**把最近对话拼进 system —— 历史由调用方作为原生 messages 传入，
 * 否则同一段历史会发两遍（token 翻倍，还可能诱导模型复读）。
 */
export function buildSystemPrompt(args: BasePromptArgs): string {
  return `${buildBaseSystemPrompt(args)}\n\n现在，按你自己的判断回应 ta。想短就短，想详细说就详细说，不用刻意压字数；记忆里的事用不用、怎么提，也由你决定。`;
}

/** App/网页专用：允许模型在明确收尾时只输出 [END]，不产生回复。 */
export function silentEndRule(channel: MessageChannel): string {
  if (channel !== 'mobile' && channel !== 'web') return '';
  return [
    '',
    '【结束对话规则】',
    '每一轮都先判断“这一句是否真的需要我回应”，不要默认一定要回。',
    '如果用户已经明确结束当前对话（例如晚安、再见、拜拜），并且没有未回答的问题、没有未完成的请求、也没有明显的情绪求助，你可以结束这轮对话，不再回复。',
    '决定不回复时，整条消息只能有 [END] 五个字符：前面不能有任何正文、动作、标点、解释，后面也不能有标点或补充。',
    '如果有一点点需要回应，就正常回复，并且不要附加 [END]。',
    '只要用户还在提问、请求、难过、焦虑、挽留，或说“在吗/等等/先别走”，就正常回复——除非你正在气头上，那种时候可以只回一两个字，或者干脆不回。',
    '用户再次开口时，必须恢复正常回复；[END] 只代表这一轮不回复，不代表永久静默。',
  ].join('\n');
}

export const SILENT_END_TOKEN = '[END]';

/**
 * 只有“整段就是 [END]”才代表 AI 决定不回。
 *
 * `正文……[END]` 不是静默：它说明模型已经决定要说话，只是多输出了标记；
 * 这种情况应剔除标记后按正常回复发送。
 */
export function isSilentEnd(text: string): boolean {
  const t = (text || '').trim();
  if (!t.includes(SILENT_END_TOKEN)) return false;
  const normalized = t
    .replace(/^["'“”‘’\s]+|["'“”‘’\s]+$/g, '')
    .replace(/[。.!！?？\s]+$/g, '')
    .trim();
  return normalized === SILENT_END_TOKEN;
}

/** 任何最终输出都去掉标记，避免泄漏到 App/网页。 */
export function stripSilentEndToken(text: string): string {
  return (text || '').replace(/\[END\]/g, '').trim();
}
