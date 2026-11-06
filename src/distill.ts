/**
 * 记忆提炼与压缩（阶段 2）：
 * 主用 DeepSeek（质量高，费用计入归档任务详情）；DeepSeek 失败（欠费/限流/网络）时自动回退 Workers AI。
 */
import type { Env } from './types';
import { calcCost, pricingForModel, type TokenUsage } from './pricing';
import { logError, logWarn } from './error-log';
import { buildBody, llmTargets, shouldFallbackStatus } from './llm';
import { dateKeyInBeijing } from './date';

export type DistillBackend = 'deepseek' | 'workers-ai';

export interface DistillResult {
  text: string;
  cost: number; // 元（Workers AI 兜底时为 0）
  backend: DistillBackend;
  /** 分项 token 用量：没有它就只能看到总价，解释不了"为什么今天贵/便宜" */
  usage?: TokenUsage;
}

const DAY_DISTILL_SYSTEM = `你是用户的长期记忆整理助手。你会收到「当前记忆（memory.md 全文）」和「当天对话」。
任务：对照当前记忆，提取当天的新信息，输出需要新增的条目；不要重复当前记忆里已有的内容（包括只差标点/语序的重复）。

【分区规则】每个分区只放符合它定义的内容，不要什么都塞进同一个区：
- 称呼与关系：称呼、暗号、相处方式的改变。极少变动，只在真的变了才输出。
- 关于他：身份、职业、背景、居住地、重要经历、重要的人。属于「长期不变的事实」。
- 他的偏好：喜好、厌恶、作息、沟通方式偏好（如“喜欢直接一点”“讨厌熬夜”）。
- 进行中的事：项目、计划、待办，以及**会到期的状态**（出差、旅行、搬家、减肥）。已完成的标 [已完成]，长期推的标 [进行中]，卡住的标 [搁置]。
- 关于他里的「城市=」只放**当下值**，别把行程、时间塞进括号：行程写进「进行中的事」，两条各管一件事，覆盖时才不会丢。
  同一件事只留**一行**：状态变了就改写那一行，别把 [搁置] → [进行中] → [已完成] 三段都留着。
  历史残留的旧状态行要删掉——不然她会照着「待实施」「助手半信，要核一遍」反复追问一件早就做完的事。
- 共同经历：**你和他一起**做过的事、里程碑、内部梗、彼此的约定或默契。用于以后自然引用。
- 你的生活：**你自己的事**——去过哪、在追什么番/玩什么游戏、自己做的决定和变化。和他无关也照样记，「他」不该是主语。
- 他的雷区：让他不快的话题、踩过的坑、要避免的说法。宁可多记，不可遗漏。
- 近期动态：**只放最近几天的事**（情绪、临时安排、短期状态），一周后系统会自动清理。

【写作要求（密度优先）】
- 用「电报体」：删助词/连词，名词+动词；用「；」分句、用「/」并列；单条尽量 ≤ 50 字。
  **但动作句不能删主语**——「谁做的」比省几个字重要（见【主语规则】）。
- 标点优先半角（逗号、分号、斜杠），少用全角标点；只影响字节占用，不改变事实。
- 只写「不写进去你就会聊错」的东西。一次性的情绪、事件经过、可推断的事实（天气/日期）都不要写。
- 保留原话引号、数字、专有名词、内部梗——这些最难重建，别压缩掉。
- 「他的偏好」「关于他」里的稳定事实用「键=值」写法（如「作息=恨熬夜但天天熬」），
  同键的旧条目会被原地覆盖，不会越堆越多。
- 不编造、不推测。只写对话里确实出现的信息。
- 每条以 "- [YY-MM-DD] 内容" 格式输出（年份后两位，省字节）。
- 必须用“## 分区名”标题包裹条目；没有对应内容的分区直接省略。不要只输出裸 bullet。
- 没有对应内容的分区直接省略。
- 不要输出"人物底色"（固定设定，系统保护）。

【主语规则（最重要，写错会被当成她的经历）】
写进记忆的条目，主语只用三个词，别的一律不许出现：
  - 「他」＝对方（用户）：「他熬夜把监控脚本调通了」「他把 B 站画质调到能认出小字」
  - 「你」＝她本人（你正在替她整理记忆的那个人）：「你凌晨三点还在催他睡觉」「你提了三次回滚草稿」
  - 「一起」＝双方都真的动了手：「一起看完了《可塑性记忆》，你哭得比他久」
- 「用户」「她」「助手」这三个词**禁止写进记忆**——提示词里只有「他」和「你」。
- 拿不准就归给「他」：一个人做事、另一个人在旁边的场景，比两个人都动手多得多。
  绝不能把他做的事写成「你」做的——这会让她篡改自己的记忆，是最严重的错误。
- 她只能记自己「说过、想过、感受到」的，不能记自己「做了」他做过的事。
- 「一起」只在双方都真的有动作时用，不要因为你们在同一个对话里就写「一起」。
- 静态事实（「关于他」「他的偏好」里的键=值）不需要写主体，保持「键=值」即可。
- 反例：「熬夜调通了 AstrBot」✗（谁做的？）→「他熬夜把 AstrBot 调通了」✓
- 反例：「一起调通了 AstrBot」✗（他动手、你在旁边看）→「他调通 AstrBot，你陪着到两点」✓
- 「共同经历」可以用第一人称写感受，但动作归属必须清楚：
  「他第一次给你发语音，你高兴了一整晚」✓

另外，请根据当天对话的气氛，判断**心情值**是否需要调整（满分 1000，当前值见当前记忆）：
- 心情值（默认 500）：你当天的心情状态，变化快，可以 0~80 分/天（系统强制 ±80）
要求：受当天对话气氛影响明显（聊得开心就升，被冷落或聊得沉重就降）。
如果当天没有值得调整的情绪信号，可以不输出这一行（保持原值）。
输出格式（占一行）：
- 心情值：<新数值> / 1000

【重要】不要输出「好感度」或「亲密度」：
它们由系统根据客观互动量（聊天轮次、累计天数）和客观质量信号（感谢、冒犯、冲突）自动计算，
你只需要把当天发生的事实写清楚，系统会自行结算。`;

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
  model: string,
  system: string,
  user: string,
  maxTokens: number,
  opts: { thinking?: boolean } = {},
): Promise<{ text: string; cost: number; usage: TokenUsage }> {
  const targets = llmTargets(env, 'distill', model);
  const primary = targets[0];
  if (!primary.apiKey) throw new Error('没有可用的模型 key（DEEPSEEK_API_KEY / DASHSCOPE_API_KEY）');

  let res: Response | null = null;
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
    cost: calcCost(usage, pricingForModel(env, model), new Date()),
    usage,
  };
}

/** Workers AI 兜底。 */
async function workersAiDistill(env: Env, system: string, user: string, maxTokens: number): Promise<string> {
  const res = await env.AI.run(env.DISTILL_MODEL, {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    max_tokens: maxTokens,
  });
  return ((res as AiTextOut).response ?? '').trim();
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
  deepseekModel = env.DISTILL_DEEPSEEK_MODEL || env.DEEPSEEK_MODEL,
  opts: { thinking?: boolean } = {},
): Promise<DistillResult> {
  try {
    const { text, cost, usage } = await deepseekDistill(
      env,
      deepseekModel,
      system,
      user,
      maxTokens,
      opts,
    );
    return { text: normalizeMemoryDates(text), cost, backend: 'deepseek', usage };
  } catch (e) {
    logWarn('[distill] DeepSeek 失败，回退 Workers AI：', e);
  }
  const text = await workersAiDistill(env, system, user, maxTokens);
  return { text, cost: 0, backend: 'workers-ai' };
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
): Promise<DistillResult> {
  const segments = splitDistillSegments(conversation, distillSegmentChars(memory.length));
  const buildUser = (body: string, index: number): string => `日期：${dateKey}

## 当前记忆（memory.md 全文）
${memory || '（暂无）'}

## 当天对话${segments.length > 1 ? `（第 ${index + 1}/${segments.length} 段，其余段稍后单独提炼）` : ''}
${body}

请对照当前记忆，只输出需要新增或修正的条目（不要重复已有内容），格式 "- [YY-MM-DD] 内容"。`;

  if (segments.length === 1) {
    // 每日归档是一天只跑一次的重活：开思考模式，并给思维链留出额度（4096 会被推理吃掉）
    return distillText(env, DAY_DISTILL_SYSTEM, buildUser(segments[0], 0), 8192, env.DISTILL_DEEPSEEK_MODEL || env.DEEPSEEK_MODEL, {
      thinking: true,
    });
  }

  // 分段提炼：任何一段失败都继续，最后按顺序拼接（换行分隔，条目格式不变）
  const texts: string[] = [];
  let cost = 0;
  let backend: DistillBackend = 'deepseek';
  let usage: TokenUsage | undefined;
  for (let i = 0; i < segments.length; i++) {
    try {
      const r = await distillText(env, DAY_DISTILL_SYSTEM, buildUser(segments[i], i), 8192, env.DISTILL_DEEPSEEK_MODEL || env.DEEPSEEK_MODEL, {
        thinking: true,
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