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
 * 清洗 AI 味（幂等，可单测）。
 * 返回 { text, cleaned }：cleaned 表示是否真的动过内容。
 */
export function scrubAiFlavor(raw: string): { text: string; cleaned: boolean } {
  let text = raw;
  let cleaned = false;

  for (const { re } of STRIP_PHRASES) {
    const next = text.replace(re, '');
    if (next !== text) {
      text = next;
      cleaned = true;
    }
  }

  // 换成"你"
  const next = replaceNin(text);
  if (next !== text) {
    text = next;
    cleaned = true;
  }

  // 清理因删除产生的多余空白/逗号残留
  const tightened = text
    .replace(/[，,]\s*[，,]+/g, '，')     // 连续逗号
    .replace(/^[，,\s]+/, '')              // 开头逗号
    .replace(/\s{2,}/g, ' ')               // 连续空格
    .replace(/[。！？!?]\s*[。！？!?]+/, (m) => m[0]); // 连续标点
  if (tightened !== text) {
    text = tightened;
    cleaned = true;
  }

  return { text: text.trim(), cleaned };
}