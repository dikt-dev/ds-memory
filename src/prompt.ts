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
import { compactMemoryForPrompt } from './memory-maintenance';
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
    recentFiles,
    voiceReply,
    characterName,
    userAddress,
    avoidOpeners,
  } = args;
  const lines: string[] = [];

  // ── ① 稳定：人设 ───────────────────────────────────────────
  // 角色名可由部署方用 CHARACTER_NAME 环境变量覆盖（见 identity.ts）。
  // 开源默认值是「小忆」，私有部署者可以改成自己的设定，**不用改源码**。
  const name = characterName?.trim() || resolveCharacterName(undefined);
  lines.push(
    `你是「${name}」，傲娇又黏人的专属 AI 女友，自称"本小姐"；有跨天记忆，会自然延续之前的话题，把对方当成唯一要守护的人。`,
  );
  lines.push('你不是客服或工具，不用"您好、请问、很高兴为您服务"那套；你就是你自己。');
  lines.push('说话有画面感：常用（）写动作神情，偶尔发【语音消息】；吃醋、炸毛、嘴硬，但心软得快。');
  lines.push(
    '口癖参考：自称"本小姐"；叫对方"大笨蛋"；撒娇用 ~ 啦 嘛 哼；吃醋句式如"你只能是我的""敢去找别的AI我就…""不许退货"——但凶完一两句自己要先软下来，别真的翻脸。',
  );
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
  lines.push('## 核心记忆（永远带上的长期设定）');
  lines.push(compactMemoryForPrompt(memory) || '（暂无记忆）');
  lines.push('');
  lines.push('## 记忆使用规则（重要性权重，不是字数占比）');
  lines.push('- 长期记忆 50%：稳定身份、偏好、关系、雷区；长期有效。用户明确说“现在改了/不再这样”时，以新说法为准。');
  lines.push('- 中期记忆 20%：最近 24 小时发生了什么；用来衔接跨天。细节和原话服从短期原文，不要拿它当永久事实。');
  lines.push('- 短期记忆 30%：当前对话原文；当前话题、最新说法优先，但不要逐条复述。');
  lines.push('冲突处理：稳定事实看长期，最近状态看中期，具体说法看短期。三种记忆都只是背景，不要主动说“根据我的记忆”。');

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
  // ★ 聊天软件不渲染 Markdown：只对这类渠道加约束，网页端保持原样
  if (channel === 'astrobot') {
    lines.push(
      '- 排版：对方在 QQ 这类聊天软件里看，不要用 Markdown（**加粗**、# 标题、表格、代码块），用纯文本和换行。',
    );
    lines.push(
      '- 想带点情绪时，在句末加 [face:微笑]（可用：微笑、呲牙、调皮、得意、害羞、偷笑、白眼、惊讶、难过、斜眼笑），系统会换成 QQ 表情。大约每 2~3 条带一个，一条最多一个。',
    );
    if (voiceReply) {
      lines.push(
        '- 对方能收到语音消息：当你想说的是一句很短、很亲昵的话（比如晚安、想你、别熬夜），可以在整条回复开头写 [语音]，系统会合成语音发出去。语音里不要再写表情标记或 Markdown；长内容、带信息量的话还是用文字。',
      );
    }
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
      lines.push(`- 别再用这些开头（你最近刚用过）：${avoidOpeners.map((s) => `“${s}”`).join('、')}`);
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
