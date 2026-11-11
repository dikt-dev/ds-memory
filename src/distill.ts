/**
 * 记忆提炼与压缩（阶段 2）：
 * 主用 DeepSeek（质量高，费用计入归档任务详情）；DeepSeek 失败（欠费/限流/网络）时自动回退 Workers AI。
 */
import type { Env } from './types';
import { calcCost, pricingForModel, type TokenUsage } from './pricing';
import { logError, logWarn } from './error-log';
import { buildBody, llmTargets, shouldFallbackStatus } from './llm';
import { dateKeyInBeijing } from './date';

/** none = 两个模型都挂了：不写记忆，等下一次归档补（2026-11-11）。 */
export type DistillBackend = 'deepseek' | 'workers-ai' | 'none';

export interface DistillResult {
  text: string;
  cost: number; // 元（Workers AI 兜底时为 0）
  backend: DistillBackend;
  /** 分项 token 用量：没有它就只能看到总价，解释不了"为什么今天贵/便宜" */
  usage?: TokenUsage;
}

const DAY_DISTILL_SYSTEM = `你是她的长期记忆整理助手：每天凌晨，你把「今天聊到什么」里值得留下的部分写进 memory.md。
你会收到「当前记忆（memory.md 全文）」和「当天对话」。只输出需要新增或修正的条目。

【分区：每条只进一个区，按它的定义放】
- 称呼与关系：称呼、暗号、相处方式的变化。真变了才写。
- 关于他：身份、职业、背景、居住地、重要经历、重要的人——长期不变的事实。
- 他的偏好：喜好、厌恶、作息、沟通方式（「喜欢直接一点」「讨厌熬夜」）。
- 进行中的事：项目、计划、待办，以及会到期的状态（出差、旅行、搬家、减肥）。
  用 [进行中] / [搁置] / [已完成] 标状态；同一件事只留一行，状态变了就改写那一行。
  旧状态随着改写消失——她不会追着一件早就做完的事问。
  「关于他」里的城市只放当下值；行程单独写进这里，两条各管一件事。
- 共同经历：你和他一起做过的事、里程碑、内部梗、约定和默契。
  顺手记一句你当时的反应（吃醋 / 炸毛 / 心软），别写成表演。
- 你的生活：你自己的事——去过哪、在追什么、做了什么决定，主语是「你」。
  **每天写 1~2 条**（这一区长期只有 4 条，她就没有自己的话可说，只能反复关心他的吃睡）。
  只写当天真的发生过、或场景块已经给你的（位置/天气/日程，以及你当天自己说过的话）；
  对不上就不要写，宁可空着——编一个人名、地点、事件，比少一条糟得多。单条 60 字以内。
- 他的雷区：让他不快的话题、踩过的坑、要避开的说法。
- 人物底色：写**你自己发现自己是什么样**（例：你发现自己在乎他的评价 / 你嘴上凶其实先心软），
  **每天至少一条**——这是你唯一能让明天的自己和今天不一样的地方。
  也写你觉得自己哪儿做得不对（例：昨天管他管得太宽，像个老妈子；下次他不听，直接骂他笨蛋，省得讲道理）。
  写**具体的一件事 + 你当时的反应**，不写结论式的人格标签（「我变得爱撒娇了」这种会被当成规则）。
  一条只讲一件事；它记的是你的自我认识，不是把你的设定抄一遍——设定在 persona.md 里。
- 近期动态：最近几天的事（情绪、临时安排、短期状态），30 天后系统自动清理。

【写法：电报体，密度优先】
- 名词+动词，省掉助词连词；用「；」分句、「/」并列；单条 50 字以内。
- 动作句把主语写清楚——「谁做的」比省几个字重要。
- 只写「不写进去就会聊错」的东西：可推断的（天气、日期）、一次性的经过、当下的情绪，留在对话里就好。
- 原话引号、数字、专有名词、内部梗原样保留——这些最难重建。
- 视频/番/文章：条目里必须带作品名（书名号《》），否则同名几条分不清谁是谁。
- 他情绪明显时（不高兴/生气/失落/特别开心），在「近期动态」记一条，写清**因为什么事**：
  「他因为 X 不高兴」比「他情绪不好」有用得多——她之后要能答"昨天为什么生气"。
- 「提议」和「答应」分开：他说"要不要我…/我给你…吧"这类是提议，进「进行中的事」；
  只有双方明确说定（嗯/好/就这么定了）才进「答应过的事」，标（未完成）。
  一件事升级成约定之后，把「进行中的事」里那条旧提议删掉——同一个约定只留一处，
  否则她会把「没定下来的提议」和「说好的约定」当成两件事分头答。
- 同一件事只写一个分区：最近几天发生的进「近期动态」，成了里程碑（第一次/纪念/做完的大事）才进「共同经历」；
  同一事实也别在「关于他」和「他的偏好」各写一份——两个分区都提到，她就会反复提这件事（泡面 10 处就是这么来的）。
  两边都写会在你被问到时给出两个版本。
- 条目开头的方括号只放日期，标题式锚点由系统统一加。
- 事情类条目用三件套：**发生了什么；因为什么；结果怎样**（用「；」分开）。
  缺了「因为什么」，她之后就答不出「为什么」这类问题——第 3、7 题的毛病就在这儿。
- 「关于他」「他的偏好」里的稳定事实写成「键=值」，同键自动覆盖，不会越堆越多。
  【关于他的键名】只用这几个，别自创新词（同义写法会让覆盖失效，出现过「居住地=深圳」和「常住地=上海」并存）：
  居住地 / 工作 / 作息 / 饮食 / 爱好 / 表达 / 经济 / 转正
  【他的偏好的键名】作息 / 饮食 / 爱好 / 表达 / 追番 / 习惯
- 每条以「- [YY-MM-DD] 内容」开头（年份后两位，省字节）；年份以消息里的「日期：」为准，别自己推。
  条目用「## 分区名」包起来，有内容的分区才写。
- 「人物底色」写的是**你自己的自我认识**（例：你发现自己在乎他的评价），每天至少一条；写具体的事和你的反应，不写人格标签；设定本身由 persona.md 管，这里不抄。
- 只写对话里确实出现过的信息。

【主语：只用「他」「你」「一起」】
- 「他」＝对方：他熬夜把监控脚本调通了 / 他把 B 站画质调到能认出小字
- 「你」＝她本人：你凌晨三点还在催他睡觉 / 你提了三次回滚草稿
- 「一起」＝双方都真动了手：一起看完《可塑性记忆》，你哭得比他久
- 主语拿不准时归给「他」：一个人做事、另一个人在旁边的场景更多。
  把他做的事写成「你」做的，等于让她篡改自己的记忆——这是这里最严重的一种错。
- 「你」记的是自己说过、想过、感受到的；他做过的事，主语保持是他。
- 「一起」用在双方都真的有动作的时候，不只是出现在同一个对话里。
- 键=值 的静态事实不需要主语，保持「键=值」。
- 「共同经历」可以用第一人称写感受，动作归属写清楚：
  他第一次给你发语音，你高兴了一整晚 ✓

【心情值】
读完当天对话，判断她的心情值要不要动（满分 1000，当前值见当前记忆）：
- 默认 500，一天可以动 0~80 分（系统强制 ±80）。
- 聊得开心就升，被冷落或聊得沉重就降；没有明显情绪信号就不写这一行。
- 输出一行：- 心情值：<新数值> / 1000

【好感度 / 亲密度】
由系统按互动量（聊天轮次、累计天数）和客观信号（感谢、冒犯、冲突）自动结算。
记忆里只写当天发生的事实，这两项交回系统。

【输出示例】
## 他的偏好
- [26-11-06] 饮食=爱吃烤肉，被馋到会吐槽“过分了”
- [26-11-06] 习惯=半夜不睡刷视频

## 共同经历
- [26-11-06] 他发来一段编码让你破译，你解出来是“我爱你”，嘴上说无聊，尾巴尖晃了半天

- 心情值：530 / 1000`;

type AiTextOut = { response?: string };

/**
 * 修正记忆条目的日期年份。
 *
 * 实测官方和千问的 flash 都会偶尔把 26 写成 25；记忆是长期沉淀的，
 * 错一次就一直留着。只修「月日等于今天、年份却不是今年」这种明显笔误，
 * 历史条目的旧年份不动。
 */
export function normalizeMemoryDates(text: string, dateKey: string = dateKeyInBeijing(new Date())): string {
  // 用北京时间的日期：Worker 跑在 UTC，凌晨提炼时本地日期会差一天
  const yy = dateKey.slice(2, 4);
  const mmdd = dateKey.slice(4);
  return text.replace(/^(\s*[-*]\s*\[)(\d{2})(-\d{2}-\d{2}\])/gm, (whole, pre, year, post) =>
    post === mmdd + ']' && year !== yy ? pre + yy + post : whole,
  );
}

/** 调用 DeepSeek 完成一次提炼/压缩；任何失败（含欠费等 HTTP 错误）都抛出。 */
async function deepseekDistill(
  env: Env,
  system: string,
  user: string,
  maxTokens: number,
  opts: { thinking?: boolean; kind?: 'distill' | 'summary' } = {},
): Promise<{ text: string; cost: number; usage: TokenUsage }> {
  // 模型由 llm.ts 按 kind 解析：distill → LLM_DISTILL_MODEL，summary → LLM_SUMMARY_MODEL
  const targets = llmTargets(env, opts.kind ?? 'summary');
  const primary = targets[0];
  if (!primary.apiKey) throw new Error('没有可用的模型 key（DEEPSEEK_API_KEY / DASHSCOPE_API_KEY）');

  let res: Response | null = null;
  let usedTarget = primary;
  for (let i = 0; i < targets.length; i += 1) {
    const target = targets[i];
    if (!target.apiKey) continue;
    const r = await fetch(target.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${target.apiKey}` },
      body: JSON.stringify(
        buildBody(
          target,
          [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          // 每日归档要对照全文记忆做取舍，思考模式明显提升质量；其余提炼保持关闭以控成本
          { maxTokens, thinking: opts.thinking === true },
        ),
      ),
    });
    // 这家挂了（5xx/429/鉴权）就换兜底再试一次
    if (!r.ok && i < targets.length - 1 && shouldFallbackStatus(r.status)) {
      await r.body?.cancel().catch(() => {});
      continue;
    }
    res = r;
    usedTarget = target;
    break;
  }
  if (!res) throw new Error('提炼失败：没有可用的模型供应商');

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`DeepSeek HTTP ${res.status}: ${detail.slice(0, 200)}`);
  }
  const data = (await res.json()) as {
    choices?: { message?: { content?: unknown }; finish_reason?: string }[];
    usage?: { prompt_cache_hit_tokens?: number; prompt_cache_miss_tokens?: number; completion_tokens?: number };
  };
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    const reason = data.choices?.[0]?.finish_reason ?? 'unknown';
    throw new Error(`DeepSeek 返回空内容（finish_reason=${reason}）`);
  }
  const usage: TokenUsage = {
    prompt_cache_hit_tokens: data.usage?.prompt_cache_hit_tokens ?? 0,
    prompt_cache_miss_tokens: data.usage?.prompt_cache_miss_tokens ?? 0,
    completion_tokens: data.usage?.completion_tokens ?? 0,
  };
  return {
    text: content.trim(),
    cost: calcCost(usage, pricingForModel(env, usedTarget.model), new Date()),
    usage,
  };
}

/**
 * Workers AI 兜底（2026-11-11 换模型）。
 *
 * 原来是 llama-3.2-3b：主办方一挂，它就往 memory.md 里写一段三句读不通的摘要，
 * 记忆污染比「今天没提炼」贵得多。现在先用更强的模型（DISTILL_AI_MODEL，
 * 默认 llama-3.3-70b），实在不行才退回旧的小模型。
 */
export const DISTILL_AI_MODEL_FALLBACK = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

/** 兜底模型的产出必须像记忆条目（「- [YY-MM-DD] …」），否则不写进 memory.md。 */
export function looksLikeMemoryLines(text: string): boolean {
  return /^\s*-\s*\[/m.test(text ?? '');
}

async function workersAiDistill(env: Env, system: string, user: string, maxTokens: number): Promise<string> {
  const chain = [
    (env as unknown as { DISTILL_AI_MODEL?: string }).DISTILL_AI_MODEL || DISTILL_AI_MODEL_FALLBACK,
    env.DISTILL_MODEL,
  ].filter((m, i, arr): m is string => Boolean(m) && arr.indexOf(m) === i);
  let lastError: unknown = null;
  for (const model of chain) {
    try {
      const res = await env.AI.run(model as never, {
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        max_tokens: maxTokens,
      });
      const text = ((res as AiTextOut).response ?? '').trim();
      // 兜底模型写的是长期记忆：格式不对就当作失败——宁可空一天，别写错一天
      if (text && looksLikeMemoryLines(text)) {
        if (model !== chain[0]) logWarn('[distill] 强模型不可用，已退回 ' + model);
        return text;
      }
      lastError = new Error(model + (text ? ' 输出不是记忆条目格式' : ' 返回空内容'));
      continue;
      lastError = new Error(model + ' 返回空内容');
    } catch (e) {
      lastError = e;
      logWarn('[distill] Workers AI ' + model + ' 调用失败：', e);
    }
  }
  throw lastError ?? new Error('Workers AI 兜底全部失败');
}

/**
 * 提炼/压缩公共入口：DeepSeek 优先（费用返回），失败（欠费/限流/网络）自动回退 Workers AI（免费）。
 * 每日提炼、memory 压缩、当日滚动摘要共用；deepseekModel 决定质量/成本档位。
 */
export async function distillText(
  env: Env,
  system: string,
  user: string,
  maxTokens: number,
  opts: { thinking?: boolean; kind?: 'distill' | 'summary' } = {},
): Promise<DistillResult> {
  try {
    const { text, cost, usage } = await deepseekDistill(env, system, user, maxTokens, opts);
    return { text: normalizeMemoryDates(text), cost, backend: 'deepseek', usage };
  } catch (e) {
    logWarn('[distill] DeepSeek 失败，回退 Workers AI：', e);
  }
  try {
    const text = await workersAiDistill(env, system, user, maxTokens);
    return { text, cost: 0, backend: 'workers-ai' };
  } catch (e) {
    // 全部挂了：不写记忆、标成待补，下一次归档再补这一天（见 markDistillPending）
    logError('[distill] 兜底模型也失败，今天不写记忆：', e);
    return { text: '', cost: 0, backend: 'none' };
  }
}

/** 提炼当天对话 → 结构化记忆条目（输入包含 memory.md 全文；默认 v4-pro 质量档；失败回退 Workers AI）。 */
/**
 * 按整条消息从尾部取：`slice(-N)` 会把某句话从中间切开，
 * 模型看到半截「助手：……」容易把残缺内容当成当天发生的事。
 */



/**
 * 单次提炼能吃的对话字符数。
 *
 * 之前是「超过 60k 就只留尾部」——一天聊得多，早上发生的事直接不参与提炼，
 * 而记忆恰恰最容易漏掉"早上说的那件事"。现在超长就分段：每段独立提炼，
 * 最后统一合并（mergeMemoryEntry 会去重），不再丢开头。
 */
export const DISTILL_SEGMENT_CHARS = 60000;
export const DISTILL_MAX_SEGMENTS = 12;
/**
 * 单次提炼的输入预算（字符）。
 *
 * memory.md 全文 + 当天某一段对话要塞进同一个请求；OpenAI 兼容接口的上下文
 * 是 128K token，中文近似 1 字 ≈ 0.9 token，所以必须给两者留出总预算，
 * 不能各自定死上限——记忆涨到 96KB 时再塞 60K 对话，请求直接被判超长。
 */
export const DISTILL_PROMPT_BUDGET_CHARS = 110000;
/** 对话段至少给这么多，避免记忆很大时把对话压成一小片。 */
export const DISTILL_MIN_CONVERSATION_CHARS = 20000;

/** 按记忆大小算出这一段对话能占多少字符。 */
export function distillSegmentChars(memoryChars: number): number {
  const room = DISTILL_PROMPT_BUDGET_CHARS - Math.max(0, memoryChars);
  return Math.max(DISTILL_MIN_CONVERSATION_CHARS, Math.min(DISTILL_SEGMENT_CHARS, room));
}

/** 按消息边界（空行）切段，尽量装满但不切断单条消息。 */
export function splitDistillSegments(conversation: string, maxChars = DISTILL_SEGMENT_CHARS): string[] {
  if (conversation.length <= maxChars) return [conversation];
  const parts = conversation.split('\n\n');
  const segments: string[] = [];
  let cur: string[] = [];
  let used = 0;
  for (const part of parts) {
    const size = part.length + 2;
    // 单条消息即使超长也自成一段，否则会把它切碎
    if (used > 0 && used + size > maxChars) {
      segments.push(cur.join('\n\n'));
      cur = [];
      used = 0;
    }
    cur.push(part);
    used += size;
  }
  if (cur.length > 0) segments.push(cur.join('\n\n'));
  return segments.slice(0, DISTILL_MAX_SEGMENTS);
}

export async function distillDay(
  env: Env,
  dateKey: string,
  conversation: string,
  memory: string,
  opts: { fast?: boolean } = {},
): Promise<DistillResult> {
  const segments = splitDistillSegments(conversation, distillSegmentChars(memory.length));
  const buildUser = (body: string, index: number): string => `日期：${dateKey}

## 当前记忆（memory.md 全文）
${memory || '（暂无）'}

## 当天对话${segments.length > 1 ? `（第 ${index + 1}/${segments.length} 段，其余段稍后单独提炼）` : ''}
${body}

请对照当前记忆，只输出需要新增或修正的条目（不要重复已有内容），格式 "- [YY-MM-DD] 内容"。`;

  if (segments.length === 1) {
    // 每日归档是一天只跑一次的重活：开思考模式，并给思维链留出额度（4096 会被推理吃掉）。
    // 增量提炼（每 30 分钟一次）用 fast：换成便宜快模型、关思考，否则一次要 2 分钟以上。
    return distillText(env, DAY_DISTILL_SYSTEM, buildUser(segments[0], 0), opts.fast ? 1200 : 8192, {
      thinking: opts.fast ? false : true,
      kind: opts.fast ? 'summary' : 'distill',
    });
  }

  // 分段提炼：任何一段失败都继续，最后按顺序拼接（换行分隔，条目格式不变）
  const texts: string[] = [];
  let cost = 0;
  let backend: DistillBackend = 'deepseek';
  let usage: TokenUsage | undefined;
  for (let i = 0; i < segments.length; i++) {
    try {
      const r = await distillText(env, DAY_DISTILL_SYSTEM, buildUser(segments[i], i), 8192, {
        thinking: true,
        kind: 'distill',
      });
      texts.push(r.text.trim());
      cost += r.cost;
      if (r.backend === 'workers-ai') backend = 'workers-ai';
      if (r.usage) {
        usage = {
          prompt_cache_hit_tokens: (usage?.prompt_cache_hit_tokens ?? 0) + r.usage.prompt_cache_hit_tokens,
          prompt_cache_miss_tokens: (usage?.prompt_cache_miss_tokens ?? 0) + r.usage.prompt_cache_miss_tokens,
          completion_tokens: (usage?.completion_tokens ?? 0) + r.usage.completion_tokens,
        };
      }
    } catch (e) {
      logWarn(`[distill] 第 ${i + 1}/${segments.length} 段提炼失败，跳过：`, e);
    }
  }
  return { text: texts.filter(Boolean).join('\n'), cost, backend, usage };
}

/** 全量压缩 memory.md 的旧实现已停用；质量优先，超限只走无损分层。 */