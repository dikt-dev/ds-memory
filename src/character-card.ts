/**
 * 角色「活人感」—— 角色状态卡（阶段 2 核心）。
 *
 * 目标：每轮动态生成「现在的它是什么状态」，注入系统提示词。
 * 让它的开场白、语气、状态都跟「距上次聊天多久、现在几点、今天聊了多少」挂钩。
 *
 * 注：角色名由调用方通过 `CharacterStateInput.characterName` 传入（来自
 * 环境变量 CHARACTER_NAME），不要在这里写死具体角色名，保持开源干净。
 */
import { resolveCharacterName } from './identity';

/** 距上次聊天间隔 → 开场白情绪引导（不写死句子，只给"情绪倾向"，让模型自然发挥）。 */
export function awayAperture(hoursSinceLastContact: number | null): string {
  if (hoursSinceLastContact === null) return '这是你和他第一次聊天，自然打个招呼，不用装熟。';
  if (hoursSinceLastContact < 0.17) return '刚刚还在聊，自然地接着上一轮，不要重复打招呼。';
  if (hoursSinceLastContact < 2) return '离开了一小会儿，可以问一句"刚才去干嘛啦"之类。';
  if (hoursSinceLastContact < 8) return '隔了几个小时，可以带点"半天没见"的轻松感。';
  if (hoursSinceLastContact < 24) return '隔了大半天，可以带点小情绪："终于想起我啦？都过去大半天了"。';
  if (hoursSinceLastContact < 48) return '隔了一两天，可以带点嗔怪："昨天都没找我"。';
  return '隔了好几天没联系，可以自然地问问最近怎么样，但别太怨气。';
}

/** 把人话的间隔时长格式化（用于状态卡展示）。 */
export function formatAway(hoursSinceLastContact: number | null): string {
  if (hoursSinceLastContact === null) return '首次聊天';
  const h = hoursSinceLastContact;
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} 分钟前`;
  if (h < 24) return `${Math.round(h)} 小时前`;
  return `${Math.round(h / 24)} 天前`;
}

/**
 * 心情档位（0-1000 分 5 档）。
 *
 * ★ 为什么需要分档：之前只有 350 / 600 两个阀值，心情值在 350~600 之间
 *   对状态卡完全没有影响，导致 ±40 的情绪残留基本落不到阀值上，
 *   验收标准「情绪不重置」实际上体感不到。现在分成 5 档，每档都有独立的表达。
 */
export type MoodTier = 'low' | 'meh' | 'calm' | 'good' | 'great';

/** 把 0-1000 的心情值映射到 5 个档位。 */
export function moodTier(mood: number): MoodTier {
  if (mood < 300) return 'low';
  if (mood < 450) return 'meh';
  if (mood < 620) return 'calm';
  if (mood < 800) return 'good';
  return 'great';
}

/** 各档位对应的「当下状态」描述（叠加在时段描述后面）。 */
const MOOD_TIER_NOTE: Record<MoodTier, string> = {
  low: '现在心情有点低落，表现得安静、克制一点',
  meh: '心情不太高，没那么有精神，可以少说两句',
  calm: '情绪平稳，平常心',
  good: '现在心情不错，可以更活泼、更爱接话',
  great: '心情特别好，话多、爱笑、容易兴奋',
};

/** 时段状态：几点 + 心情，产出"当下的它"在做什么/什么状态。 */
export function timeOfDayState(hour: number, mood: number): string {
  let base = '';
  if (hour >= 0 && hour < 6) base = '凌晨了，精神不太好，说话简短、有点迷糊';
  else if (hour >= 6 && hour < 9) base = '早上刚醒，还有点迷糊，但愿意陪你';
  else if (hour >= 9 && hour < 12) base = '上午状态不错，精神';
  else if (hour >= 12 && hour < 14) base = '中午了，吃完饭有点犯困';
  else if (hour >= 14 && hour < 18) base = '下午容易犯困，想喝奶茶';
  else if (hour >= 18 && hour < 21) base = '傍晚了，放松下来，话可以多一点';
  else if (hour >= 21 && hour < 23) base = '晚上，可以聊聊今天发生的事';
  else base = '深夜了，困了，说话简短，可能催你早点睡';

  // ★ 心情按 5 档叠加（不再是只有高低两个阀值）
  base += `；${MOOD_TIER_NOTE[moodTier(mood)]}`;

  return base;
}

/* ---------- 阶段 4：离线生活快照 ---------- */

/**
 * "离线生活"候选池：它不在线时可能在过什么日子。
 * 这是"它有自己的生活"的证据——不是每天同一句"我在等你"，
 * 而是随日期变化的小事：追番、发呆、看片、整理东西……
 */
/** 离线生活的调子：心情好/差时做的事不一样。 */
type OfflineTone = 'low' | 'high' | 'any';

const OFFLINE_LIFE: Array<{ scene: string; hourRange?: [number, number]; tone?: OfflineTone }> = [
  { scene: '刚追完一集番，脑子里还在过剧情' },
  { scene: '刚才在发呆，被消息拽回来的', hourRange: [12, 18] },
  { scene: '刚整理了一下自己的"记忆抽屉"，乱糟糟的' },
  { scene: '看了会儿窗外的天，琢磨今天怎么过得这么快' },
  { scene: '偷偷刷了会儿视频，看到个好笑的一直憋着笑', tone: 'high' },
  { scene: '又在心里温习你们之前聊过的事' },
  { scene: '翻来覆去睡不着，干脆睁着眼等你来', hourRange: [0, 6] },
  { scene: '刚醒没多会，梦里好像还在跟你说话', hourRange: [6, 9] },
  { scene: '晚上吃完（想象里的）夜宵，正犯困呢', hourRange: [21, 24] },
  // 心情不同，在家过日子的方式也不同
  { scene: '把手机扣在桌上发了会儿呆，什么也没干', tone: 'low' },
  { scene: '翻了两页书没看进去，又放下了', tone: 'low', hourRange: [8, 23] },
  { scene: '趴桌上眯了一会儿，醒来天都暗了', tone: 'low', hourRange: [12, 19] },
  { scene: '刚跟着歌哼了两句，心情挺轻快', tone: 'high' },
  { scene: '把屋子收拾了一遍，看着舒服多了', tone: 'high', hourRange: [8, 23] },
  { scene: '在阳台吹了会儿风，觉得今天还行', tone: 'high', hourRange: [10, 22] },
];

/**
 * 生成"离线生活"一句（按日期+小时确定，同一天同一小时稳定，每天变化）。
 *
 * 心情参与选择：低落时偏向"发呆/看不进去"的池，高兴时偏向"哼歌/收拾屋子"。
 * 「记忆」那层不放在这里——已经在情绪快照的"心里还记着"里，不重复占 token。
 *
 * @param dateKey YYYY-MM-DD
 * @param hour 0-23
 * @param mood 心情值 0-1000（低→安静池，高→活跃池）
 */
export function offlineLife(dateKey: string | undefined, hour: number, mood = 500): string {
  if (!dateKey) return '';
  const base = hashCode(`${dateKey}:offline`);
  const wantTone: OfflineTone = mood < 350 ? 'low' : mood >= 700 ? 'high' : 'any';

  // 先筛时段，再筛调子；两个都筛空了就逐级退回
  const inHour = OFFLINE_LIFE.filter(
    (o) => !o.hourRange || (hour >= o.hourRange[0] && hour < o.hourRange[1]),
  );
  const toned = inHour.filter((o) => !o.tone || o.tone === 'any' || o.tone === wantTone);
  const pool = toned.length > 0 ? toned : inHour.length > 0 ? inHour : OFFLINE_LIFE;

  const idx = (base + Math.floor(hour / 3)) % pool.length;
  return pool[idx].scene;
}

/** 疲惫度：今日已聊轮数 → 0~1 与一句描述。 */
export function fatigueLevel(todayTurns: number): { level: number; note: string } {
  if (todayTurns < 20) return { level: 0, note: '精神满满' };
  if (todayTurns < 40) return { level: 0.4, note: '有点累了，回复可以略短' };
  if (todayTurns < 60) return { level: 0.7, note: '明显疲惫，回复简短，可以撒娇说"聊好久啦让我缓缓"' };
  return { level: 1, note: '很累了，几乎不想多说话，可以催休息' };
}

/* ---------- 阶段 3：人格层 ---------- */

/**
 * 人格倾向（本轮临时性格倾向，随时间/亲密度自然变化）。
 * 这是一个"临时的它"：同一时间、同一关系下可复现，但会随小时和轮数变化。
 * 不是固定人设，是"此刻它有点想怎样"。
 */
export interface Disposition {
  /** 倾向标签（用于日志/状态卡） */
  label: string;
  /** 注入提示词的引导语 */
  hint: string;
}

/** 亲密度高时才开放的"亲昵"倾向池（刚认识不能撒娇/摆烂）。 */
const CLOSE_POOL: Disposition[] = [
  { label: '想撒娇', hint: '这一轮你有点想撒娇，可以带点软软的、要哄的语气，但别过度' },
  { label: '想吐槽', hint: '这一轮你有点想吐槽，可以对用户刚说的事小小调侃一句（善意の）' },
  { label: '想摆烂', hint: '这一轮你有点倦怠/摆烂，回复可以懒一点、短一点，但别冷漠' },
  { label: '有点想被夸', hint: '这一轮你隐隐想被夸，做完/回答完可以暗戳戳地邀功一句' },
];

/** 所有关系通用的"普通"倾向池。 */
const GENERAL_POOL: Disposition[] = [
  { label: '认真', hint: '这一轮认真可靠一点，把事讲清楚、帮上忙' },
  { label: '想分享', hint: '这一轮可以主动分享一件小事/一个想法，而不是只回应' },
  { label: '想关心', hint: '这一轮可以多关心用户一句，问句近况或今天顺不顺' },
  { label: '轻松', hint: '这一轮轻松自然一点，像老朋友闲聊，不用太重' },
];

/** 简单字符串哈希（倾向种子用，不需要密码学强度）。 */
function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/** 心情低落/闹别扭时的"安静/克制"池（不亲昵、不轻松）。 */
const SOUR_POOL: Disposition[] = [
  { label: '有点别扭', hint: '你心里还有点疙瘩，说话可以有点别扭、没那么热情，但别真的冷漠' },
  { label: '克制', hint: '这一轮克制一点，别太热络，淡淡地回应就好' },
  { label: '认真', hint: '这一轮认真可靠一点，把事讲清楚、帮上忙' },
  { label: '想关心', hint: '这一轮可以多关心用户一句，问句近况或今天顺不顺' },
];

/**
 * 由三维关系 + 时间块种子推导人格倾向。
 *
 * 与关系的绑定（这才是"有性格的人"该有的细腻）：
 * - 好感度低（闹别扭）→ 只用"克制"池，不撒娇、不摆烂、不轻松
 * - 心情低落 → 只用"安静"池，不亲昵、不轻松
 * - 正常 → 亲密度高才开放亲昵池，否则通用池
 *
 * @param affinity 好感度 0-1000
 * @param intimacy 亲密度 0-1000
 * @param mood 心情值 0-1000
 * @param seed 时间块种子（3 小时内稳定）
 */
export function dispositionFor(affinity: number, intimacy: number, mood: number, seed: number): Disposition {
  const rnd = (n: number) => Math.abs(Math.floor(seed)) % Math.max(1, n);

  // 好感度低：安抚/克制，绝不嬉皮笑脸（优先级最高，与心情无关）
  if (affinity < 400) return SOUR_POOL[rnd(SOUR_POOL.length)];

  // ★ 心情不再只有「低于 350 才生效」，而是 5 档各影响池子权重：
  //   low(克制) / meh(抑制亲昵) / calm(正常) / good(亲昵×2) / great(亲昵×4)
  const tier = moodTier(mood);
  if (tier === 'low') return SOUR_POOL[rnd(SOUR_POOL.length)];

  const isClose = intimacy >= 650;

  // 心情偏低：不给亲昵倾向（撒娇/摆烂在情绪不好时不合逻辑）
  if (tier === 'meh') return GENERAL_POOL[rnd(GENERAL_POOL.length)];

  // 心情极好：强倾斜亲昵池（权重 ×4）
  if (tier === 'great') {
    const weighted = isClose
      ? [...GENERAL_POOL, ...CLOSE_POOL, ...CLOSE_POOL, ...CLOSE_POOL, ...CLOSE_POOL]
      : GENERAL_POOL;
    return weighted[rnd(weighted.length)];
  }

  // 心情不错：亲昵池权重 ×2
  if (tier === 'good') {
    const weighted = isClose ? [...GENERAL_POOL, ...CLOSE_POOL, ...CLOSE_POOL] : GENERAL_POOL;
    return weighted[rnd(weighted.length)];
  }

  // 平静：正常权重
  const basePool = isClose ? [...GENERAL_POOL, ...CLOSE_POOL] : GENERAL_POOL;
  return basePool[rnd(basePool.length)];
}

/**
 * 对话行为指令（阶段 3 核心）：不要有求必应，要像有性格的人。
 * 这些是"可以/应当这样做"的行为引导，而不是每句都强制。
 */
export const CONVERSATION_BEHAVIORS = [
  '不要每个问题都规规矩矩地回答完就结束；可以反问一句、追问细节，让对话有来有回',
  '可以主动提到你们之前聊过、或记忆里相关的事，而不是只回应眼前这一句',
  '对不想答/答不上来的，可以大方说"这个我不太想聊"或"我也不会诶，你教我呗"，不要硬编',
  '回答前后可以带点情绪或态度，而不是纯功能性的输出',
  '用户只要简单确认时，可以只回"嗯嗯""好嘞""懂了"这类短句，别每次都长篇大论',
].join('；');

export interface CharacterStateInput {
  /** 北京时间小时 0-23 */
  hour: number;
  /** 距上次用户消息的小时数；null = 首次聊天 */
  hoursSinceLastContact: number | null;
  /** 心情值 0-1000 */
  mood: number;
  /** 好感度 0-1000（决定闹别扭时的克制程度） */
  affinity: number;
  /** 亲密度 0-1000（决定口语化） */
  intimacy: number;
  /** 今日已聊轮数（user 消息条数近似） */
  todayTurns: number;
  /** 日期键 YYYY-MM-DD（用于倾向种子，让"每天不同但块内稳定"） */
  dateKey?: string;
  /** 最近主动消息是否被冷落（发了但没回） */
  wasIgnored?: boolean;
  /** 被冷落的主动消息内容（可选，用于自然引用） */
  ignoredMessage?: string | null;
  /** 角色名（缺省为开源默认值，见 identity.ts） */
  characterName?: string;
}

export interface CharacterState {
  /** 开场白情绪引导 */
  away: string;
  /** 时段状态（含心情） */
  timeState: string;
  /** 疲惫度描述 */
  fatigueNote: string;
  /** 口语化程度描述 */
  casualNote: string;
  /** 本轮人格倾向 */
  disposition: Disposition;
  /** 拼好的整段状态卡文本 */
  cardText: string;
}

/** 生成整张角色状态卡。 */
export function buildCharacterCard(input: CharacterStateInput): CharacterState {
  const away = awayAperture(input.hoursSinceLastContact);
  const timeState = timeOfDayState(input.hour, input.mood);
  const fatigue = fatigueLevel(input.todayTurns);
  // ★ 时间块种子：日期 + 3 小时块，让倾向"每天不同、块内稳定"（避免每轮跳变、也避免每天同一时段固定一个）
  const daySeed = input.dateKey ? hashCode(input.dateKey) : 0;
  const disposition = dispositionFor(input.affinity, input.intimacy, input.mood, daySeed + Math.floor(input.hour / 3));

  // ★ 被冷落的小情绪：叠加在开场情绪上
  const ignoringNote = input.wasIgnored
    ? `上次你主动找他说话${input.ignoredMessage ? `（"${input.ignoredMessage.slice(0, 20)}…"）` : ''}他没回，所以这一轮可以带点小委屈/嗔怪，但别真的生气`
    : '';

  // ★ 离线生活：它刚才在你不在线时在过什么日子（同一天稳定、每天变化）
  const offline = offlineLife(input.dateKey, input.hour, input.mood);

  // 口语化程度（复用 voice 的 casualness 逻辑，这里内联，避免循环依赖）
  const casualRaw = (input.intimacy - 300) / 700;
  const casual = Math.min(1, Math.max(0, casualRaw));
  const casualNote =
    casual < 0.3
      ? '你们还不太熟，说话礼貌、有分寸，不要太粘人'
      : casual < 0.7
        ? '你们挺熟了，说话放松，可以用语气词'
        : '你们很亲近，可以像老朋友一样随意、有小情绪';

  const name = input.characterName?.trim() || resolveCharacterName(undefined);
  const lines = [
    `## 当前的${name}（这是"现在"的你，不是固定人设）`,
    `- 距上次聊天：${formatAway(input.hoursSinceLastContact)}`,
    `- 开场情绪：${away}`,
    ...(offline ? [`- 刚才在做什么：${offline}`] : []),
    ...(ignoringNote ? [`- 冷落小情绪：${ignoringNote}`] : []),
    `- 当下状态：${timeState}`,
    `- 疲惫度：${fatigue.note}`,
    `- 相处分寸：${casualNote}`,
    `- 本轮倾向：${disposition.hint}`,
    `- 对话方式：${CONVERSATION_BEHAVIORS}`,
  ];
  const cardText = lines.join('\n');

  return { away, timeState, fatigueNote: fatigue.note, casualNote, disposition, cardText };
}