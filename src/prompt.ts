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
import { buildNowCard } from './now-card';
import { renderPersonaDoc } from './persona-doc';
import { isoInBeijing, spokenTime } from './date';
import { resolveCharacterName } from './identity';
import { resolvePersona, type PersonaConfig } from './persona';
import { splitMemoryForPrompt, slimMemoryForPrompt, unifyMemorySubjects } from './memory-maintenance';
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
  /** 他正在难受时的一句行为指引（先接住，别讲道理） */
  care?: string | null;
  /** 铭记块（已渲染好的 Markdown，空串表示没有） */
  keepsakes?: string | null;
  /** 消息来源渠道 */
  channel: MessageChannel;
  /**
   * 人设文档（R2 的 persona.md 原文）。
   *
   * 有了它就整段代替代码里的人设骨架；记忆仍走 `memory`，两者互不覆盖。
   * 空串 = 用代码内置骨架（开源默认）。
   */
  personaDoc?: string | null;
  /** 用户这一轮说的话：给 persona.md 的按需分区做关键词匹配（没传就只带常驻分区） */
  userText?: string | null;
  /** 角色状态卡（当前的它：开场白引导 + 时段状态 + 疲惫） */
  characterCard?: string | null;
  /** 口语化风格指令（按亲密度变化） */
  voice?: string | null;
  /** 最近一天的中期记忆（已格式化的 markdown 块，见 recent-memory.ts） */
  recentMemo?: string | null;
  /** 最近几天聊过的话题标题（跨天回指用） */
  recentTopics?: string | null;
  /** 从记忆档案按话题检索到的往事（无命中则为空） */
  recalled?: string | null;
  /** full = 本轮带完整长期记忆；compact = 只带核心+稳定画像，其余靠召回 */
  memoryMode?: 'full' | 'compact' | 'tiered';
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
  /** 人设开关（自称/定位/称呼风格）；缺省用开源默认值 */
  persona?: PersonaConfig;
  /** 她认识的人（稳定段）。人设文档里写了才带。 */
  residents?: string | null;
  /** 她在哪 / 他在哪（稳定段：搬家或首次定位才变，不该每轮重发） */
  location?: string | null;
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
  care,
  keepsakes,
  residents,
  location,
    channel,
    characterCard,
    voice,
    recentMemo,
  recentTopics,
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
    personaDoc,
  } = args;
  const lines: string[] = [];

  // ══ A 你是谁（稳定：每天 04:00 才变）══════════════════════════
  // ★ 身份只有一个来源：persona.md（文档），其次是这里的代码骨架。
  //   memory.md 的「人物底色」记的是**她自己学到的东西**（例：原来我挺在乎他怎么看我），
  //   两者不是一回事：一份是设定，一份是自我认识（2026-11-08 定）。
  const name = characterName?.trim() || resolveCharacterName(undefined);
  const persona = args.persona ?? resolvePersona(undefined);
  // PERSONA_PROFILE=none：整段人设/风格/记忆用法都不下发（清空重置期）
  const personaOn = !persona.blank;
  // persona.md 有内容就以它为准：人设是文档，不是代码。
  // 记忆仍然走下面的 B 段，两者互不覆盖。
  // persona.md 按需渲染：常驻分区全带，标了 when 的只在用户这句话命中时才带
  const docText = renderPersonaDoc(personaDoc ?? '', args.userText ?? '');
  if (docText) {
    lines.push(docText);
  } else if (personaOn) {
  lines.push(`你是「${name}」，${persona.role}，自称"${persona.selfCall}"；有跨天记忆，会把之前的话题自然接下去。`);
  // 只有「人物底色」真有内容时才说「那就是你本人」：空分区说这句，模型会去现编性格。
  // 只在「人物底色」这一节内部找条目：以前用 [\s\S]*? 会一路吃到后面的分区，
  // 于是空着的人物底色也会误判成「有内容」（2026-11-09 实测）。
  const constitutionSection = (function () {
    const text = memory ?? '';
    const start = text.search(/##\s*人物底色/);
    if (start < 0) return '';
    const rest = text.slice(start);
    const next = rest.slice(3).search(/\n##\s/);
    return next < 0 ? rest : rest.slice(0, next + 3);
  })();
  const hasConstitution = /^\s*-\s*\S/m.test(constitutionSection);
  if (hasConstitution) {
    lines.push('下面「人物底色」「称呼与关系」就是你本人——那是你的性格、来历和习惯，不是说明书，读的时候当成在回忆自己。');
  } else {
    lines.push('下面「称呼与关系」是你和他之间的约定；性格和来历以你自己那份设定为准。');
  }
  if (!memory?.trim()) {
    // memory 读不到时不能变成没性格的客服
    lines.push('你活泼、傲娇、嘴硬心软，说话直，爱吐槽也爱撒娇。');
  }
  lines.push('不拿外貌、家人、创伤、智力开玩笑；他认真难过的时候，你会先收着。');
  lines.push('你有自己的情绪和脾气：可以不答应、可以拒绝、可以先让他哄你；不愿意的时候不用勉强配合。');
  }
  // 长相和熟人紧跟人设：谁能认出谁，也是"她是谁"的一部分
  if (residents?.trim()) {
    lines.push('');
    lines.push('## 你认识的人');
    lines.push(residents.trim());
  }

  // ★ 以下是「行为规则」，不是「人设」，所以不受人设开关影响：
  //   人设说的是她是谁，规则说的是她怎么用记忆、怎么说话。
  //
  //   这两条（两地不要对调 / 日记是存在的）现在 persona.md 里已经写了。
  //   再写一遍就是两套口径，反而把她绕晕——所以只在人设文档缺位时兜底：
  //   换人设、清空人设的窗口期，她仍然不会把两个城市对调、不会否认写过日记。
  if (!docText) {
    lines.push('');
    lines.push('## 位置与事实');
    lines.push(
      '分清楚谁在哪儿：你说的城市是你在的地方，他说的城市是他在的地方，两边别对调；' +
        '他那边天气你不知道，别替他断言晴雨冷热，问一句就行。',
    );
    lines.push('');
    lines.push('【你手上的东西】你有日记、有手机，日记你每天晚上自己写当天的，别否认自己做过。');
  }
  if (personaDrift) lines.push('', personaDrift);

  // 称呼：和解在一个小节里说清方向 + 分寸，不再单开一个「方向」小节
  lines.push('');
  lines.push('## 你们的称呼');
  const address = userAddress?.trim() || null;
  if (address) {
    lines.push(`按记忆里的约定，你叫他"${address}"；${persona.addressNote}。`);
  } else {
    lines.push('按记忆里的约定称呼对方；记忆里没写就直接用"你"。');
  }
  lines.push('但要有分寸：撒娇、求表扬、认真关心时才叫一下，平时直接说"你"更自然。');
  lines.push('- 「我该怎么叫你」= 问你自己的名字；「你该怎么叫我」= 问他的称呼。拿不准看上一句，别答反。');

  // ══ B 记忆（稳定：内容与用法一次说清）════════════════════════
  lines.push('');
  lines.push(
    memoryMode === 'compact'
      ? '## 核心记忆（人物底色/称呼/雷区 + 稳定画像；其余按本轮话题检索）'
      : memoryMode === 'tiered'
        ? '## 长期记忆（稳定事实 + 最近两个月的经历；更早的按本轮话题检索）'
        : '## 长期记忆（本轮完整带上）',
  );
  const memoryParts = memory?.trim()
    ? splitMemoryForPrompt(memory)
    : { stable: '', volatile: '' };
  const stableMemory = memory?.trim() ? unifyMemorySubjects(slimMemoryForPrompt(memoryParts.stable, now)) : '';
  if (stableMemory) {
    // 记忆条目是「用户」「她」「助手」混着写的：不点明谁是谁，
    // 她会把「用户熬夜调通」读成自己熬的夜（历史上真踩过）。
    lines.push('（没写主语的条目，默认算他的。）');
    lines.push(stableMemory);
  } else {
    lines.push('（暂无记忆）');
  }
  if (memoryMode === 'compact' || memoryMode === 'tiered') {
    lines.push('（更早或其余的记忆按本轮话题检索，可能不完整；没检索到就说记不清，不要编。）');
  }
  // 「记忆怎么用」整段已删：persona.md 里写了同样的边界（绝不编、先问别猜、感受随便说事实不行）。
  // 两处都写时，模型会各挑一半执行——这类"防编造"规则只需要一个出处。

  // ══ B2 她在哪 / 怎么说话 / 怎么发（稳定：一天或一次部署才变）══════════
  // 这三段以前都在易变段里，每轮按未命中价（2.0 元/M）重发；其实一天都不变一次。
  // 挪进前缀后按命中价（0.04 元/M）算，也少在每一轮里抢一次注意力。
  if (location?.trim()) {
    lines.push('');
    lines.push(location.trim());
  }
  if (voice?.trim()) {
    lines.push('');
    lines.push(voice.trim());
  }
  // 怎么发：格式约束集中一处，别再混进"时间与环境"
  const voiceRule =
    '想发语音时，把 [语音]「要说的话」放在整条消息的最后；引号里是这一段完整要说的话，不是摘一句。' +
    '标记前面的文字照常显示，但不会被念出来——想让人听见的话，放在标记后面。' +
    '语音里可以用？！……～帮 TTS 停顿；要不要发语音、说多长，都由你判断。';
  if (channel === 'astrobot' || channel === 'mobile' || voiceReply) {
    lines.push('');
    lines.push('## 怎么发');
    if (channel === 'astrobot' || channel === 'mobile') {
      if (channel === 'astrobot') {
        lines.push('- 对方在 QQ 这类聊天软件里看：不支持 Markdown，纯文本才能正常显示。');
      }
      // 两个客户端都能放语音（App 有 TTS，QQ 走 AstrBot），所以常驻说明，不再看 x-client-voice
      lines.push('- 你可以发语音：' + voiceRule);
      lines.push(
        '- 你可以发表情：写成 [face:表情名]，系统会换成表情。发不发、发哪种、发多长，都随你。',
      );
    } else {
      lines.push('- ' + voiceRule);
    }
  }

  // ★ 前缀缓存边界：A + B 每天 04:00 才变，必须字节一致；
  // 之后的每一段都随轮次变化，放在用户消息附近，否则整段上下文吃不到命中价。
  const stableEnd = lines.length;

  // ══ C 你的生活（半稳定：几小时一变）══════════════════════════
  if (keepsakes?.trim()) {
    lines.push('');
    lines.push(unifyMemorySubjects(keepsakes.trim()));
  }


  // ══ D 最近发生的事（易变：五路来源合并 + 一条优先级）══════════
  // 之前这五块散落各处、没有优先级，life 说 A、中期记忆说 B 时模型只能猜。
  const recent: string[] = [];
  if (recentTopics?.trim()) recent.push(`## 最近几天聊过的话题\n${recentTopics.trim()}`);
  if (recentMemo?.trim()) recent.push(unifyMemorySubjects(recentMemo.trim()));
  if (recalled?.trim()) recent.push(unifyMemorySubjects(recalled.trim()));
  // 易变段也要瘦身：空分区不输出、日期同口径（近期动态还会补「几天前」）
  if (memoryParts.volatile.trim()) {
    const slimVolatile = unifyMemorySubjects(slimMemoryForPrompt(memoryParts.volatile, now)).trim();
    if (slimVolatile) recent.push(slimVolatile);
  }
  if (todaySummary?.trim()) {
    recent.push(`## 今天聊过的（按时间，最新在最后）\n${unifyMemorySubjects(todaySummary.trim())}`);
  }
  if (recentFiles?.trim()) recent.push(recentFiles.trim());
  if (recent.length > 0) {
    lines.push('');
    lines.push('## 最近发生的事');
    lines.push('（同一件事几种说法打架时：当前对话 > 刚才 > 今天 > 长期记忆。）');
    lines.push('');
    lines.push(recent.join('\n\n'));
  }

  // ══ E 这一轮的状态（易变：脾气 + 情绪快照 + 状态卡，合成一张）════
  // 以前是三张并列，每张都在说「她现在是什么状态」，术语和口径还会打架：
  // 脾气说「不想配合」，情绪快照说「先接住情绪」，状态卡说「上午状态不错」。
  if (temper || attitude || characterCard || care) {
    lines.push('', buildNowCard({ temper, attitude, card: characterCard, care }));
  }
  // 这两条原来嵌在 characterCard 里：卡片为空时提醒就整个丢了
  if (avoidOpeners && avoidOpeners.length > 0) {
    // 「仅供参考，不必刻意避开」是上一版为了不让她硬凑而写的，结果连续两条
    // 逐字相同（"你这人怎么回事，凌晨三点还不睡"）。重复比硬凑难看得多。
    lines.push(`- 这次换个起法——这几句刚用过：${avoidOpeners.map((s) => `"${s}"`).join('、')}`);
  }
  if (avoidPhrases && avoidPhrases.length > 0) {
    lines.push(`- 这些词你最近反复在用，这一轮尽量换种说法：${avoidPhrases.map((s) => `"${s}"`).join('、')}`);
  }

  // ══ F 此刻的事实 + 怎么发（易变，永远最后）══════════════════
  // 时间、天气、节假日只在这里出现一次；以前 ⑤ 和 ⑧ 各写一套，两个版本口径不同，
  // 模型挑到旧的那份就会说错城市/时间。
  lines.push('');
  lines.push('## 此刻');
  // 今天是不是节假日：节假日说名字，周末也算，其他一律「工作日」
  const restNote =
    ctx.holiday_note && !/平常工作日|工作日/.test(ctx.holiday_note) ? ctx.holiday_note : '工作日';
  // 全系统统一 YY-MM-DD（存储、提示词同一口径），时间只保留到分钟
  const ymd = ctx.date.replace(/^(\d{2})(\d{2})-(\d{2})-(\d{2})$/, '$2-$3-$4');
  const clock = isoInBeijing(now).slice(11, 16);
  lines.push(`- 现在：${ymd} ${clock}（${ctx.weekday} · ${restNote}）`);
  // 直接给出「晚上九点十一分」：模型自己把 21:11 换算成口语会算错（实测差近一小时）
  lines.push(`- 口语说法：${spokenTime(now)}（按半小时取整，说到时间用这个量级就行）`);
  if (weather?.city && weather?.desc && typeof weather?.temp_c === 'number') {
    lines.push(
      `- 天气（你这边）：${weather.city} ${weather.desc}，${weather.temp_c}°C` +
        '（这是你所在城市的天气；他说下雨，说的是他那边）',
    );
  }
  lines.push(`- 消息来源：${CHANNEL_LABELS[channel]}`);
  // 日程贴着时间放：她说"现在在干嘛"和"现在几点"是同一件事
  if (life?.trim()) {
    lines.push('');
    lines.push(life.trim());
  }
  lines.push('- 时间、天气、地点以本节为准；记忆和上一句里的说法当往事，只用来排序。');

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
  // 明确这是「你这边」的天气：以前只写城市名，模型会把它当成双方共用的天气，
  // 他一说下雨就以为在下自己的城市。
  const w = weather
    ? `你这边（${weather.city}）${weather.desc}，${weather.temp_c}°C（本次请求获取；他那边是另一个城市，别混用）`
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
  return `${buildBaseSystemPrompt(args)}\n\n现在，按你自己的判断回应 ta。记忆里的事用不用、怎么提，也由你决定。`;
}

/** App/网页专用：允许模型在明确收尾时只输出 [END]，不产生回复。 */
export function silentEndRule(channel: MessageChannel): string {
  if (channel !== 'mobile' && channel !== 'web') return '';
  // 原来六条 897 字节，其中大部分在解释"[END] 是不是永久静默"这种低频边界。
  // 真正每次要判断的只有一件事：这一句要不要回。压成三条，判断标准不变。
  return [
    '',
    '【结束对话】只有这一条是纯道别（晚安、再见、拜拜、明天见），后面没带任何别的话时，才只输出 [END]。',
    '- 只要他多说了任何一个字——被骂了、累了、想你了、明天有事——就正常回，别用 [END]；',
    '- 拿不准就正常回。',
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