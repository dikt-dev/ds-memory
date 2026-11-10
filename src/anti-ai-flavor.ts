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
import { sanitizeProactiveText } from './proactive';

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
  // 报幕句：把"接下来要说正事"这种元叙述去掉，直接说事
  { re: /不过(先)?说(?=正事)/g, why: '报幕句' },
  { re: /不过先说(正事|一下)/g, why: '报幕句' },
  { re: /对了[，,]?还有(件事|一件事)/g, why: '报幕句' },
  { re: /先说正事[：:，,]?/g, why: '报幕句' },
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

  const next = fixParticlePunctuation(replaceNin(text));
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
 * 历史时间标签只是提示词元信息，模型有时会模仿到回复开头。
 * 兼容 `[10-28 08:57]`、`[10-2808:57]`、`【10-28 08:57】` 等。
 */
export function stripLeadingTimeLabels(raw: string): string {
  const re =
    /^\s*[\[【［]\s*(?:(?:\d{2,4}[-/])?\d{1,2}[-/]\d{1,2}\s*)?\d{1,2}:\d{2}(?::\d{2})?\s*[\]】］]\s*/;
  // 回复是按行拆成气泡的，标签常常出现在**第二段**开头：
  // 「噗，第一张…」换行「[11-03 10:15] 后面那个红果子…」。只剥开头就漏了这一条。
  // 用 [ 	]* 而不是 s*，否则多行模式下会把上一行的换行吃进去，两段粘成一段。
  const reLine =
    /^[ \t]*[\[【［][ \t]*(?:(?:\d{2,4}[-/])?\d{1,2}[-/]\d{1,2}[ \t]*)?\d{1,2}:\d{2}(?::\d{2})?[ \t]*[\]】］][ \t]*/gm;
  let text = raw;
  for (let i = 0; i < 3; i++) {
    const next = text.replace(re, '');
    if (next === text) break;
    text = next;
  }
  // 也有夹在句子中间的：「…挺得意的。[11-03 10:15] 后面那个红果子…」
  // App 是按句子/换行拆气泡的，标签一旦落在句中，第二段气泡开头就带着它。
  const reAfterPunct =
    /([。！？!?\n])[ \t]*[\[【［][ \t]*(?:(?:\d{2,4}[-/])?\d{1,2}[-/]\d{1,2}[ \t]*)?\d{1,2}:\d{2}(?::\d{2})?[ \t]*[\]】］][ \t]*/g;
  return text.replace(reLine, '').replace(reAfterPunct, '$1');
}

/**
 * 清洗 AI 味（幂等，可单测）。
 * 返回 { text, cleaned }：cleaned 表示是否真的动过内容。
 *
 * ★ 若清洗后只剩标点/空白，text 会被置为空串——
 *   调用方（chat.ts / openai.ts）的 `if (text.trim())` 就会跳过落库，
 *   避免「？」单独成为一条消息。
 */

/** 括号里的纯语气说明：这些是舞台指示，不是说话内容。 */
const TONE_PAREN = /[（(](?:语气|声音|语调|尾音|嗓音|嗓门|音量)[^）)]{0,40}[）)]/g;

/**
 * 舞台指示限流（确定性兜底）。
 *
 * 提示词已经要求"一条最多一个动作、不要用括号解释语气"，模型仍会超量——
 * 这里只做**减法**，不改语义：语气括号直接去掉，动作括号最多留两个（留前面的，
 * 后面的一般是补充描述）。
 */
export function limitStageDirections(text: string, max = 1): string {
  let out = text.replace(TONE_PAREN, '');
  const parens = /[（(][^）)]{0,60}[）)]/g;
  const found = out.match(parens) ?? [];
  if (found.length <= max) return tidySpaces(out);
  let kept = 0;
  out = out.replace(parens, (m) => {
    kept += 1;
    return kept <= max ? m : '';
  });
  return tidySpaces(out);
}

/**
 * 语气词后面补逗号：「嗯挑着呢」→「嗯，挑着呢」。
 *
 * 只在句首或标点之后补，避免把「嗯嗯」「好嘞」这类词拆开；
 * 只补逗号，不改任何字。
 */
export function fixParticlePunctuation(text: string): string {
  // 第一类：句首独立的语气词（嗯/哦/哼…）。不含「好」，「好啊」「你好啊」会被误断。
  const head = text.replace(
    /(^|[，。！？…\n])(嗯|哦|噢|哼|唉|诶|行吧)(?=[\u4e00-\u9fa5])(?![嗯哦噢哼唉诶])/gu,
    (m: string, pre: string, particle: string) => `${pre}${particle}，`,
  );
  // 第二类：句子中间的句末语气词直接接下一句（「加饭啊不是刚定的嘛」）。
  // 真正常见的是「啊/呀/呢/吧/嘛/诶」后面该断开却没断，读起来像乱码。
  return head.replace(
    /([\u4e00-\u9fa5])([啊呀呢吧嘛诶])(?=[\u4e00-\u9fa5])(?![啊呀呢吧嘛诶])/gu,
    (m: string, before: string, particle: string) => `${before}${particle}，`,
  );
}

/** 删掉括号后留下的重复标点与多余空格。 */
function tidySpaces(text: string): string {
  return text
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/，\s*，/g, '，')
    .replace(/^[，。、\s]+/, '')
    .replace(/\s+([，。！？])/g, '$1')
    .trim();
}

/**
 * 去掉句首的括号动作：「（顿了顿）行吧」→「行吧」。
 *
 * 句首动作最容易把聊天读成剧本；句中保留一个还能接受，开头一个都不该有。
 */
export function stripLeadingStageDirection(text: string): string {
  const m = text.match(/^\s*[（(][^）)]{1,20}[）)]\s*/);
  if (!m) return text;
  const rest = text.slice(m[0].length);
  // 全是动作、后面没话了，就留着（不然会变成空消息）
  return rest.trim() ? rest : text;
}

export function scrubAiFlavor(raw: string): { text: string; cleaned: boolean } {
  // 主动消息的收尾清理收进这里：以前是两份实现，一份线上、一份只有测试
  const source = sanitizeProactiveText(raw);
  // 2026-11-06：与提示词对齐——动作/语气括号交给模型自己决定，后处理不再删。
  // 以前这里会删句首动作、只留 1 个括号，导致「用户看到的」和「落库的」不是同一句。
  const withoutTime = stripLeadingTimeLabels(source);
  const applied = applyRules(withoutTime);
  const finalText = applied.text.trim();

  // ★ 只剩标点的空壳一律归空：否则「？」「！」会成为一条真实消息
  if (finalText && isMeaninglessResidue(finalText)) {
    return { text: '', cleaned: true };
  }

  return { text: finalText, cleaned: applied.cleaned || withoutTime !== raw };
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
  // 还没真正吐出过内容：这段时间里所有「开头时间标签」都要继续剥。
  // 不能只在第一个 delta 剥一次——模型常常先发一个空 delta，
  // 之后再发 `[10-30 21:36]（先是一怔…`，只剥一次就会漏给用户看。
  let emitted = false;
  return {
    push(delta: string): string {
      buf += delta;
      if (!emitted) {
        buf = stripLeadingTimeLabels(buf);
        const head = buf.trimStart();
        if (!head) return '';
        const openBracket = head.startsWith('[') || head.startsWith('【') || head.startsWith('［');
        const closed = head.includes(']') || head.includes('】') || head.includes('］');
        // 只扣住「看起来像半截标签」的前缀；超过 40 字就按正文处理
        if (openBracket && !closed && buf.length < 40) return '';
        emitted = true;
      }
      if (buf.length <= hold) return '';
      const cut = buf.length - hold;
      const out = applyRules(buf.slice(0, cut)).text;
      buf = buf.slice(cut);
      return out;
    },
    flush(): string {
      if (!emitted) buf = stripLeadingTimeLabels(buf);
      const out = applyRules(buf).text;
      buf = '';
      return out;
    },
  };
}