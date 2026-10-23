/**
 * 小忆「活人感」—— AI 味兜底清洗（确定性后处理）。
 *
 * 为什么需要这一层：
 * 禁用词目前只靠系统提示词软约束，模型偶尔还是会蹦出"您好""请问还有什么需要"这类套话。
 * 这一层是**最后的确定性防线**：无论模型输出什么，都会在落库/推送前把套话清掉。
 *
 * 只替换最确定的、绝不可能自然出现的套话，避免误伤正常内容。
 */

/** 需要整体抹掉的短语（命中即删除，不替换成别的）。 */
const STRIP_PHRASES: Array<{ re: RegExp; why: string }> = [
  { re: /很高兴(能够)?帮助[您你]?/g, why: '客服套话' },
  { re: /(?:很|非常)?高兴(?:能|可以)?(?:为|帮)[您你](?:服务|解答问题|回答|提供帮助)/g, why: '客服套话' },
  { re: /请问还有什么(需要|可以帮[您你]?)/g, why: '客服追问' },
  { re: /(还)?有什么(其他)?需要(帮[您你]|我帮[您你])?的(吗|呢)?/g, why: '客服追问' },
  { re: /如需(进一步)?帮助/g, why: '客服套话' },
  { re: /(希望|祝)我的(回答|回复)对[您你]有帮助/g, why: '客服套话' },
  { re: /(根据|依照)我的(记忆|记录|资料)/g, why: '元话术，像在翻文件' },
  { re: /作为一个?(人工智能|AI|语言模型|大模型)/g, why: '自曝身份' },
  { re: /让我(为你|为您|来)?(总结|分析)(一下)?/g, why: '工具腔' },
  { re: /综上所述/g, why: '书面腔' },
  { re: /总而言之/g, why: '书面腔' },
];

/** 整体替换（把"您"换成"你"，但只替换完整单字，避免误伤含"您"的合法词——中文里"您"几乎只在称谓）。 */
function replaceNin(text: string): string {
  return text.replace(/您/g, '你');
}

/**
 * 判断文本是否只剩标点/空白（删完套话后的空壳）。
 *
 * 例：「请问还有什么需要？」清洗后剩「？」，看上去非空，
 * 但落库后会变成一条无意义的回复、还会污染记忆提炼。
 *
 * ★ 判定策略（保守，宁可放过不可误杀）：
 *   1. 去掉标点/空白/零宽字符后什么都不剩 → 空壳
 *   2. 只由单字语气助词组成、且**总长度≤3 且带重复**（如「吗？」「呢呢」）→ 空壳
 *   但「嗯嗯」「哈哈」这类是有实际对话功能的短回应，必须保留。
 *   因此只把「孤立单助词 + 标点」这种典型清扫残留当空壳。
 */
export function isMeaninglessResidue(text: string): boolean {
  // 去掉所有标点、空白、零宽字符、emoji 变体选择符
  const stripped = text
    .replace(/[\s\u3000]/g, '')
    .replace(/[，。、；：！？,.;:!?~～…\-—－_'""''（）()【】\[\]{}《》<>·•*#@&%+=\/\\|^$`]/g, '')
    .replace(/[\u200b-\u200f\u2060\ufeff]/g, '')
    .replace(/[\uFE00-\uFE0F]/g, '');

  if (stripped.length === 0) return true;

  // 只剩疑问/语气助词，且**不是重复叠词**（叠词「嗯嗯」「哈哈」是正常回应）
  const isAllParticle = /^[吗呢啊吧呀哦嘛呗哟噢诶欸唉哇]+$/.test(stripped);
  const isRepeated = /^(.)\1+$/.test(stripped);
  if (isAllParticle && !isRepeated) return true;

  return false;
}

/** 清理文字层面的排版垃圾（聊天里出现 markdown 会很出戏）。 */
function stripMarkdown(text: string): { text: string; cleaned: boolean } {
  let out = text
    .replace(/^#{1,6}\s+/gm, '') // 标题符号
    .replace(/^>\s+/gm, '') // 引用
    .replace(/\*\*([^*\n]+)\*\*/g, '$1'); // 加粗
  const cleaned = out !== text;
  return { text: out, cleaned };
}

/** 应用全部确定性清洗（不含 trim 与空壳判定，流式与整段共用）。 */
function applyRules(raw: string): { text: string; cleaned: boolean } {
  let text = raw;
  let cleaned = false;

  for (const { re } of STRIP_PHRASES) {
    const next = text.replace(re, '');
    if (next !== text) {
      text = next;
      cleaned = true;
    }
  }

  const noMarkdown = stripMarkdown(text);
  if (noMarkdown.cleaned) {
    text = noMarkdown.text;
    cleaned = true;
  }

  const next = replaceNin(text);
  if (next !== text) {
    text = next;
    cleaned = true;
  }

  const tightened = text
    .replace(/[，,]\s*[，,]+/g, '，') // 连续逗号
    .replace(/^[，,\s]+/, '') // 开头逗号
    .replace(/\s{2,}/g, ' ') // 连续空格
    .replace(/([。！？，、；：])\s+/g, '$1') // 中文标点后不该跟空格（模型偶尔中英混排留下）
    .replace(/[。！？!?]\s*[。！？!?]+/, (m) => m[0]); // 连续标点
  if (tightened !== text) {
    text = tightened;
    cleaned = true;
  }

  return { text, cleaned };
}

/**
 * 清洗 AI 味（幂等，可单测）。
 * 返回 { text, cleaned }：cleaned 表示是否真的动过内容。
 *
 * ★ 若清洗后只剩标点/空白，text 会被置为空串——
 *   调用方（chat.ts / openai.ts）的 `if (text.trim())` 就会跳过落库，
 *   避免「？」单独成为一条消息。
 */
export function scrubAiFlavor(raw: string): { text: string; cleaned: boolean } {
  const applied = applyRules(raw);
  const finalText = applied.text.trim();

  // ★ 只剩标点的空壳一律归空：否则「？」「！」会成为一条真实消息
  if (finalText && isMeaninglessResidue(finalText)) {
    return { text: '', cleaned: true };
  }

  return { text: finalText, cleaned: applied.cleaned };
}

export interface StreamScrubber {
  push(delta: string): string;
  flush(): string;
}

/**
 * 流式清洗器：扣住尾部一小段，保证跨 chunk 的套话能被完整匹配。
 *
 * ★ 为什么需要：原来只在流结束、落库前清洗，但 SSE 已经把原文推给用户了——
 *   库里是干净的，用户看到的是「您」「很高兴为您服务」。这里是用户实际可见的那一层。
 *
 * hold 必须 ≥ 最长匹配串长度，否则短语会被切断、漏扫。
 * 代价是首字晚 hold 个字（默认 18，约半句话）。
 */
export function createStreamScrubber(hold = 18): StreamScrubber {
  let buf = '';
  return {
    push(delta: string): string {
      buf += delta;
      if (buf.length <= hold) return '';
      const cut = buf.length - hold;
      const out = applyRules(buf.slice(0, cut)).text;
      buf = buf.slice(cut);
      return out;
    },
    flush(): string {
      const out = applyRules(buf).text;
      buf = '';
      return out;
    },
  };
}