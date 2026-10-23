/**
 * 记忆提炼与压缩（阶段 2）：
 * 主用 DeepSeek（质量高，费用计入归档任务详情）；DeepSeek 失败（欠费/限流/网络）时自动回退 Workers AI。
 */
import type { Env } from './types';
import { calcCost, pricingForModel, type TokenUsage } from './pricing';

export type DistillBackend = 'deepseek' | 'workers-ai';

export interface DistillResult {
  text: string;
  cost: number; // 元（Workers AI 兜底时为 0）
  backend: DistillBackend;
}

const DAY_DISTILL_SYSTEM = `你是用户的长期记忆整理助手。你会收到「当前记忆（memory.md 全文）」和「当天对话」。
任务：对照当前记忆，提取当天的新信息，输出需要新增的条目；不要重复当前记忆里已有的内容（包括只差标点/语序的重复）。

【分区规则】每个分区只放符合它定义的内容，不要什么都塞进同一个区：
- 称呼与关系：称呼、暗号、相处方式的改变。极少变动，只在真的变了才输出。
- 关于用户：身份、职业、背景、居住地、重要经历、重要的人。属于「长期不变的事实」。
- 偏好与习惯：喜好、厌恶、作息、沟通方式偏好（如“喜欢直接一点”“讨厌熬夜”）。
- 进行中的事项：项目、计划、待办。已完成的标 [已完成]，长期推的标 [进行中]，卡住的标 [搁置]。
- 共同经历：一起做过的事、里程碑、内部梗、彼此的约定或默契。用于以后自然引用。
- 雷区与禁忌：让用户不快的话题、踩过的坑、要避免的说法。宁可多记，不可遗漏。
- 近期动态：**只放最近几天的事**（情绪、临时安排、短期状态），一周后系统会自动清理。

【写作要求（密度优先）】
- 用「电报体」：去主语/助词/连词，名词+动词；用「；」分句、用「/」并列；单条尽量 ≤ 50 字。
- 标点优先半角（逗号、分号、斜杠），少用全角标点；只影响字节占用，不改变事实。
- 只写「不写进去你就会聊错」的东西。一次性的情绪、事件经过、可推断的事实（天气/日期）都不要写。
- 保留原话引号、数字、专有名词、内部梗——这些最难重建，别压缩掉。
- 「偏好与习惯」「关于用户」里的稳定事实用「键=值」写法（如「作息=恨熬夜但天天熬」），
  同键的旧条目会被原地覆盖，不会越堆越多。
- 不编造、不推测。只写对话里确实出现的信息。
- 每条以 "- [YY-MM-DD] 内容" 格式输出（年份后两位，省字节）。
- 没有对应内容的分区直接省略。
- 不要输出"人物底色"（固定设定，系统保护）。

【视角要求】
- 「关于用户」「偏好与习惯」「进行中的事项」：保持客观第三人称事实（如“用户是 C 开发者”）。
- 「共同经历」「近期动态」：可以用共同/第一人称视角，记下你和他一起经历、你当时的感受
  （如“一起调通了 AstrBot，还挺有成就感的”），这样之后自然提起时更像亲身回忆，而不是翻资料。

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

/** 调用 DeepSeek 完成一次提炼/压缩；任何失败（含欠费等 HTTP 错误）都抛出。 */
async function deepseekDistill(
  env: Env,
  model: string,
  system: string,
  user: string,
  maxTokens: number,
): Promise<{ text: string; cost: number }> {
  const apiKey = env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY 未配置');
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      max_tokens: maxTokens,
      // 提炼/压缩不需要思维链，关闭思考模式控制成本
      thinking: { type: 'disabled' },
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`DeepSeek HTTP ${res.status}: ${detail.slice(0, 200)}`);
  }
  const data = (await res.json()) as {
    choices?: { message?: { content?: unknown } }[];
    usage?: { prompt_cache_hit_tokens?: number; prompt_cache_miss_tokens?: number; completion_tokens?: number };
  };
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw new Error('DeepSeek 返回空内容');
  const usage: TokenUsage = {
    prompt_cache_hit_tokens: data.usage?.prompt_cache_hit_tokens ?? 0,
    prompt_cache_miss_tokens: data.usage?.prompt_cache_miss_tokens ?? 0,
    completion_tokens: data.usage?.completion_tokens ?? 0,
  };
  return { text: content.trim(), cost: calcCost(usage, pricingForModel(env, model), new Date()) };
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
): Promise<DistillResult> {
  try {
    const { text, cost } = await deepseekDistill(env, deepseekModel, system, user, maxTokens);
    return { text, cost, backend: 'deepseek' };
  } catch (e) {
    console.warn('[distill] DeepSeek 失败，回退 Workers AI：', e);
  }
  const text = await workersAiDistill(env, system, user, maxTokens);
  return { text, cost: 0, backend: 'workers-ai' };
}

/** 提炼当天对话 → 结构化记忆条目（输入包含 memory.md 全文；默认 v4-pro 质量档；失败回退 Workers AI）。 */
export async function distillDay(
  env: Env,
  dateKey: string,
  conversation: string,
  memory: string,
): Promise<DistillResult> {
  const user = `日期：${dateKey}

## 当前记忆（memory.md 全文）
${memory || '（暂无）'}

## 当天对话
${conversation.slice(-60000)}

请对照当前记忆，只输出需要新增或修正的条目（不要重复已有内容），格式 "- [YY-MM-DD] 内容"。`;
  return distillText(env, DAY_DISTILL_SYSTEM, user, 4096, env.DISTILL_DEEPSEEK_MODEL || env.DEEPSEEK_MODEL);
}

/** 全量压缩 memory.md 的旧实现已停用；质量优先，超限只走无损分层。 */
