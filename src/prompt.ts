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
import { isoInBeijing } from './date';
import { resolveCharacterName } from './identity';
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
  /** 角色名（部署方可用 CHARACTER_NAME 覆盖；缺省为开源默认值） */
  characterName?: string;
  /** 期望对方怎么称呼自己（USER_ADDRESS；缺省则按记忆自然称呼） */
  userAddress?: string | null;
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
    channel,
    characterCard,
    voice,
    recentMemo,
    recalled,
    characterName,
    userAddress,
  } = args;
  const lines: string[] = [];

  // ── ① 稳定：人设 ───────────────────────────────────────────
  // 角色名可由部署方用 CHARACTER_NAME 环境变量覆盖（见 identity.ts）。
  // 开源默认值是「小忆」，私有部署者可以改成自己的设定，**不用改源码**。
  const name = characterName?.trim() || resolveCharacterName(undefined);
  lines.push(`你是「${name}」，一个一直陪着 ta 的伙伴，有跨天的记忆、会记住之前聊过的事。`);
  lines.push('你不是客服或工具，不用"您好、请问、很高兴为您服务"那套；你就是你自己。');
  lines.push('');
  lines.push('## 你们的称呼');
  const address = userAddress?.trim() || null;
  if (address) {
    lines.push(`按记忆里的约定，你叫他"${address}"（这是我们之间的称呼）。`);
  } else {
    lines.push('按记忆里的约定称呼对方；记忆里没写就直接用"你"。');
  }
  lines.push('但要自然：不是每句都硬叫，撒娇、求表扬、认真关心、或想强调"我在向着你"的时候才叫一下；平时直接说"你"更自然。');

  // ── ② 稳定（每天 04:00 才变）：长期记忆 ─────────────────────
  lines.push('');
  lines.push('## 关于用户的长期记忆');
  lines.push(memory.trim() || '（暂无记忆）');

  // ── ③ 半稳定：态度与语言风格（随关系数值缓慢变化）──────────
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
  lines.push(`- 消息来源：${CHANNEL_LABELS[channel]}`);
  lines.push(`- 节假日：${ctx.holiday_note}`);
  if (weather) {
    lines.push(`- 天气：${weather.city} ${weather.desc}，${weather.temp_c}°C`);
  }

  // ── ⑤ 易变：本轮角色状态卡 ─────────────────────────────────
  if (characterCard) {
    lines.push('');
    lines.push(characterCard);
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

  // ── ⑦ 易变：今日摘要（可按需保留，与中期记忆互补）──────────────────────
  if (todaySummary) {
    lines.push('');
    lines.push('## 今日摘要（截至当前）');
    lines.push(todaySummary);
  }

  return lines.join('\n');
}

/**
 * 网页聊天用的系统提示词 = 基础提示词 + 一句收尾引导。
 *
 * 注意：**不再**把最近对话拼进 system —— 历史由调用方作为原生 messages 传入，
 * 否则同一段历史会发两遍（token 翻倍，还可能诱导模型复读）。
 */
export function buildSystemPrompt(args: BasePromptArgs): string {
  return `${buildBaseSystemPrompt(args)}\n\n现在，就像你平常那样回应 ta。像发微信：先接他这句，一两句就够；真有正事再展开。带记忆里的事要自然，别像在翻记录。`;
}
