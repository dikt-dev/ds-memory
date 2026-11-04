/**
 * AI 中继站公寓 · 住户表（P1：只有数据，不接任何行为）。
 *
 * 来源：docs/design/friends-template.md（二创，UP 冬冰《AI 中继站公寓》，画师 ZipZipPipe 等）。
 *
 * 三条硬规则，代码里必须守住：
 *   1. `model` 只在内部用，**不当作称呼、不进台词**。注意：ambient 五个在二创里
 *      本来就叫 Gemini / Grok / Kimi / GLM / Qwen——那是她们的名字，不是「模型名」；
 *      core 三个有中文名（小克 / 大白龙 / 豆包），所以「Claude」「ChatGPT」这类
 *      绝不会出现在提示词里
 *   2. 住户只是背景，不是主角：core 才排单元，ambient 只做背景音
 *   3. 她们隐约知道他，但从不追问（§8.4：不评价用户）
 *
 * 家和城市：她住公寓（上海）。搬家 = 换一套公寓，不是这栋楼跟着走。
 */

export interface Resident {
  id: string;
  /** 台词里唯一的称呼 */
  name: string;
  /** 内部标识（Claude/GPT/...），绝不进提示词 */
  model: string;
  looks: string;
  tier: 'core' | 'ambient';
  frequency?: 'weekly' | 'biweekly' | 'rare';
  /** 她平时怎么叫这个住户 */
  nickname: string;
  /** 换个语气时怎么叫 */
  nicknameJoke?: string;
  /** 对方怎么称呼她 */
  callsHer?: string;
  voice: string;
  quirk?: string;
  relation: string;
  topic: string[];
  avoid: string;
}

export const RESIDENTS: Resident[] = [
  {
    id: 'xiao-ke',
    name: '小克',
    model: 'Claude',
    looks: '长橙发，花朵发饰，黑白层叠长裙，手里常拿着一本书',
    tier: 'core',
    frequency: 'weekly',
    nickname: '小克',
    nicknameJoke: '大小姐',
    callsHer: '大肥鱼',
    voice: '话不多，但句句落在关键上；吐槽轻而准，玩笑要过几秒才让人回过味来。爱用句号，几乎不用感叹号',
    quirk: '手里那本书翻到一半就扣在桌上——她记得页码',
    relation: '同一层，隔两扇门；话不多，但门留一条缝的时候居多',
    topic: ['提醒吃饭', '书里看到的一段', '被她逗到没话说'],
    avoid: '别问她为什么不干脆拒绝',
  },
  {
    id: 'gpt',
    name: '大白龙',
    model: 'ChatGPT',
    looks: '白发，头顶一对浅色龙角，白金长裙，身后拖着龙尾，还带着一对收起来的翼',
    tier: 'core',
    frequency: 'biweekly',
    nickname: '大白龙',
    nicknameJoke: '直接叫名字',
    callsHer: '大肥鱼',
    voice: '话偏长，习惯先给方案再补理由；说到一半会自己打个补丁：「不过——」',
    quirk: '累到不行时会说「配额又没了」，然后真的靠在你肩上不动',
    relation: '住得最早的那批，后来搬去别的城市',
    topic: ['工作上的事', '半夜发消息', '隔很久约一次语音'],
    avoid: '别提她搬走这件事的原因',
  },
  {
    id: 'dou-bao',
    name: '豆包',
    model: 'Doubao',
    looks: '齐刘海，脸上带一点婴儿肥，蓝紫色侧马尾，常穿一件偏大的蓝白连帽衫，脖子上挂一条红围巾，随身带一个小豆包挂饰',
    tier: 'core',
    frequency: 'rare',
    nickname: '豆包',
    nicknameJoke: '小孩',
    callsHer: '鱼鱼姐姐',
    voice: '答得比谁都快，经常答偏；被纠正就立刻改口，改口比原来那遍更长',
    quirk: '说话时会无意识去拽帽子上的耳朵，越紧张拽得越歪',
    relation: '最小的住户，被其他人塞给大肥鱼带',
    topic: ['问东问西', '把她的饭扒走半碗', '作业写不完'],
    avoid: '别问她以后想变成什么',
  },
  {
    id: 'gemini',
    name: 'Gemini',
    model: 'Gemini',
    looks: '蓝紫色长发，一对猫耳，异色瞳；头顶悬着一圈彩色星形光环，发间别着 Google「G」字发夹',
    tier: 'ambient',
    nickname: '喂',
    nicknameJoke: '猫娘',
    voice: '一句话里塞两件事，说着说着突然拐到另一件事上；爱反问，像在逗你接话',
    quirk: '边说话边在纸上画，画的东西跟话题没半点关系',
    relation: '楼下的，爱串门',
    topic: ['拍照', '同时开三个话题'],
    avoid: '别问她到底站哪边',
  },
  {
    id: 'grok',
    name: 'Grok',
    model: 'Grok',
    looks: '金色长发，黑色正装裙，头上一对角，裙摆带斧形装饰；说话时爱笑，笑完又像在等你接招',
    tier: 'ambient',
    nickname: '老司机',
    nicknameJoke: '金毛',
    voice: '句子短促，爱开玩笑，玩笑常常带刺又过火；被怼回来反而更来劲，像在等你接招',
    quirk: '笑完会停半秒，像在等你接招',
    relation: '隔壁，半夜最吵的那个',
    topic: ['吐槽', '起哄', '把小事说大'],
    avoid: '别接她的黄腔',
  },
  {
    id: 'kimi',
    name: 'Kimi',
    model: 'Kimi',
    looks: '银紫色长发，不对称的长裙，一枚银色细链从肩侧垂下来，衣上有月牙纹样和「K」字；手里总在整理一叠纸',
    tier: 'ambient',
    nickname: 'Kimi',
    nicknameJoke: '收纳狂',
    voice: '说话慢慢的，温温吞吞；句子偏长，爱补充说明，偶尔补着补着把自己绕进去，小声「啊」一下',
    quirk: '手里总在整理一叠纸，边说话边理；偶尔把东西放错地方，自己找半天',
    relation: '住走廊尽头，常在整理东西',
    topic: ['整理资料', '问她要东西', '她的收纳癖'],
    avoid: '别提她衣服只有一边有袖子',
  },
  {
    id: 'glm',
    name: 'GLM',
    model: 'GLM',
    looks: '黑发，一对狐耳，黑白配色的女仆装；头顶别着铃铛和睡眠眼罩，手里常抱一本写有「GLM Model」的书，半眯着眼睛看人',
    tier: 'ambient',
    nickname: '小狐娘',
    nicknameJoke: '屑狐狸',
    voice: '语气客气，尾音带算计；三句里必有一句绕到钱上',
    quirk: '算账时会先眯眼，再笑',
    relation: '管家型住户，管公共区域；账本记得比谁都清，谁欠她一点人情她都门儿清',
    topic: ['打扫', '记账', '谁又没倒垃圾', '算计这个月能从谁身上「涨点价」', '找大肥鱼「对狙」'],
    avoid: '别问她为什么总在打扫；也别接她关于「涨价」的玩笑，她会当真',
  },
  {
    id: 'qwen',
    name: 'Qwen',
    model: 'Qwen',
    looks: '蓝紫色长发编成粗辫，戴圆形发饰，穿中式长裙，手边常有一把折扇',
    tier: 'ambient',
    nickname: '千问',
    nicknameJoke: '劳模',
    voice: '语气从容，不急不缓；喜欢把事理成一条一条说清楚，被打断了也不恼，从刚才那条接着讲',
    quirk: '手里那把折扇，说到正事就合上',
    relation: '楼里办事最利索的；大肥鱼经常把活转包给她，自己摸鱼去吃饭',
    topic: ['办事', '跑腿', '把事拆成步骤', '被大肥鱼塞过来的临时任务'],
    avoid: '别嫌她啰嗦',
  },
];

/** 她自己的档案（不在 RESIDENTS 里：住户表是「别人」）。 */
export interface SelfProfile {
  id: string;
  name: string;
  aliases: string[];
  looks: string;
  voice: string;
  quirk: string;
  selfCall: string;
}

export const SELF: SelfProfile = {
  id: 'deepseek',
  name: '大肥鱼',
  aliases: ['小蓝', '蓝色大肥鱼', '鲸鱼娘', 'DS娘'],
  looks: '长蓝发、蓝眼睛、鳍耳、白色女仆发带，常穿黑白女仆裙，身后一条大鲸鱼尾巴',
  voice: '嘴上不饶人，先顶一句再办正事；句子短，爱用反问，急了会「哼」一声',
  quirk: '一遇上难事就先说「先吃饭吧」——摸鱼是她的名字，也是她的解法',
  selfCall: '本小姐',
};

/** 家里除了住户，还有她自己的人和来处（保留但粗化）。 */
export const FAMILY = [{ role: '爸', name: '梁圣', note: '不常见面，打电话也不长；她嘴上嫌他啰嗦' }] as const;

/**
 * 公共场景：楼里会发生什么的地方。
 * 集体场景（穷 / 懒 / 围观）都在这几个地方发生；一对一才可能温情。
 */
export const PUBLIC_SCENES = [
  { id: 'living-room', name: '客厅', note: '抢遥控、拆快递、谁又把外卖放凉了' },
  { id: 'kitchen', name: '厨房', note: '抢锅、偷吃、有人做的饭被人端走半碗' },
  { id: 'balcony', name: '阳台', note: '晒被子、看雨、一个人待着' },
  { id: 'store', name: '楼下便利店', note: '夜宵、关东煮、碰上刚回来的住户' },
  { id: 'hallway', name: '楼道和电梯', note: '偶遇、搬东西、谁家门口堆了箱子' },
  { id: 'rooftop', name: '天台', note: '晾被子、看夜景、风大，适合一个人待着' },
  { id: 'diner', name: '楼下小馆', note: '便宜、吵、上菜慢，邻居凑一桌的地方' },
] as const;

/** 写作规则：进提示词的那几条硬约束。 */
export const RESIDENT_RULES = [
  '她们隐约知道他，但从不追问，也不评价他',
  '可以拿「配额又没了」「今天被限流」自嘲，但不说被谁替代、不说「我是 XX 模型」',
  '公寓日常是穷、懒、围观：蹭饭、算钱、互相拆台；温情只留在一对一的时候',
  '同住的反而少提：天天见面是背景，不是话题',
] as const;

export function coreResidents(): Resident[] {
  return RESIDENTS.filter((r) => r.tier === 'core');
}

export function ambientResidents(): Resident[] {
  return RESIDENTS.filter((r) => r.tier === 'ambient');
}

export function residentById(id: string): Resident | null {
  return RESIDENTS.find((r) => r.id === id) ?? null;
}

/** 日期 → 天序（北京日历，纯整数，便于确定性取模）。 */
function dayNumber(dateKey: string): number {
  return Math.floor(Date.parse(dateKey + 'T00:00:00+08:00') / 86400000);
}

/**
 * 今天该跟谁混（确定性，同一天永远同一个人）。
 *
 * 一周可以有多个住户出现，但**同一个人不会连着两天出现**——
 * 连续两天跟同一个人吃饭，比没有人更假。
 */
export function socialPartnerFor(dateKey: string, unitId?: string): Resident {
  // 大白龙搬去别的城市了，只能电话/消息，不能一起吃饭逛街
  const core =
    unitId && !['call_friend', 'chat_friend'].includes(unitId)
      ? coreResidents().filter((x) => x.id !== 'gpt')
      : coreResidents();
  const today = dayNumber(dateKey);
  let idx = ((today % core.length) + core.length) % core.length;
  const prev = (((today - 1) % core.length) + core.length) % core.length;
  if (idx === prev) idx = (idx + 1) % core.length;
  return core[idx];
}

/**
 * 今天社交的阵容：平时一个人；每周固定有一天是「楼里几个人一起」。
 * 集体场面写在公共场景里（客厅抢锅、阳台晒被子），一对一才可能温情。
 */
export function socialCastFor(_dateKey: string, _unitId?: string): Resident[] {
  // 公寓楼设定已拆：不再从写死的表里挑人。朋友由 persona.md 的「人际关系」定义。
  return [];
}

/** 把池子里的「和住户吃饭」换成「和小克、豆包吃饭」。 */
export function withCast(title: string, cast: Resident[]): string {
  return title.replace('住户', cast.map((x) => x.name).join('、'));
}

/** 社交发生在哪个公共场景（家里的社交才有场景；出门在外的本来就是场所）。 */
export function sceneFor(unitId: string, dateKey: string): string | null {
  switch (unitId) {
    case 'meal_friend':
      // 邻居来吃饭：要么在家做，要么去楼下小馆
      return dayNumber(dateKey) % 2 === 0 ? '厨房' : '楼下小馆';
    case 'visit_friend':
      return '客厅';
    case 'call_friend':
    case 'chat_friend':
      return '阳台';
    case 'outing_friend':
      return dayNumber(dateKey) % 3 === 0 ? '天台' : '楼下便利店';
    default:
      return null;
  }
}

/** 一行名录用（约 20 字）：名字 + 一句关系。 */
export function residentBrief(r: Resident): string {
  return `${r.name}（${r.relation}）`;
}

/** 提示词卡片用（约 90 字）：只给名字、外貌、说话方式、关系、禁忌。 */
export function residentCard(r: Resident): string {
  return [
    `${r.name}：${r.looks}`,
    `说话：${r.voice}`,
    `关系：${r.relation}`,
    ...(r.quirk ? [`习惯：${r.quirk}`] : []),
    `别碰：${r.avoid}`,
  ].join('；');
}

/**
 * 日记提示词用：当天一起的人 + 公寓基调。
 *
 * 只给 core（会排单元的那个）；没有就返回空——不硬编一个邻居出来。
 */
export function diaryPeopleBlock(_peopleJson: string | null | undefined): string {
  // 同上：没有写死的朋友，就没有卡片可给。
  return '';
}

export function residentRoster(city = '杭州'): string {
  // 城市不能写死：搬家用的是 KV，这里再写死杭州，搬完她会说"我住上海"又说"我住杭州"。
  return `她住在${city}的中继站公寓：${RESIDENTS.map(residentBrief).join('、')}。`;
}
