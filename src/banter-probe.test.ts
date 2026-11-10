/**
 * 口语体检探针：30 条不同处境的话，量「像不像活人」，并对比 voice 三档。
 *
 * 为什么放这儿：仓库里没有 tsx / vite-node，只有 vitest 能直接跑 TS。
 * 所以用环境变量开关，正常测试跑不到它：
 *   # 1) 先把真实人设 / 记忆拉到本地（只读，不改线上）
 *   npx wrangler r2 object get ds-memory-r2/persona.md --remote --config wrangler.local.toml --file=.tmp-banter/persona.md
 *   npx wrangler r2 object get ds-memory-r2/memory.md  --remote --config wrangler.local.toml --file=.tmp-banter/memory.md
 *   # 2) 跑探针（MODES 可写 lite / bare / full，逗号分隔）
 *   $env:BANTER_PROBE="1"; $env:BANTER_MODES="lite,bare,full"; npx vitest run src/banter-probe.test.ts
 *
 * 组装近似度：人设 + 现网「## 说话」规则 + memory.md + 固定 6 条真实历史。
 * 不含此刻卡 / 脾气 / 召回 / 24h 摘要——所以它衡量的是「同一套人格与规则下，她对这句话的第一反应」，
 * 用来比较档位、抓回归很准；最终结论仍以线上观察为准。
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { buildVoiceDirective, type VoiceMode } from './voice';

const ENV: Record<string, string | undefined> =
  (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};

const ENABLED = ENV.BANTER_PROBE === '1';
const MODEL = ENV.BANTER_MODEL || 'deepseek-flash';
const SHOTS = Math.max(1, Number(ENV.BANTER_SHOTS) || 1);
const DIR = ENV.BANTER_DIR || '.tmp-banter';
const MODES = (ENV.BANTER_MODES || 'lite')
  .split(',')
  .map((m) => m.trim())
  .filter((m): m is VoiceMode => m === 'bare' || m === 'lite' || m === 'full');

/** 今天 12:05~14:44 的真实往来：她已经在「别又泡面」「别穿短裤」的框里。 */
const HISTORY: Array<['user' | 'assistant', string]> = [
  ['user', '那肯定还是泡面了，都还没有处理完'],
  ['assistant', '又泡面啊（把手机夹在肩膀和耳朵中间）那四桶还没吃完呢，中午就吃这个，青菜呢'],
  ['user', '明天才降温，今天温度还行'],
  ['assistant', '行吧，那今天先放过你（把拼图块拨到一边）明天要是还穿短裤，我可真记你一笔'],
  ['user', '哈哈，你就放心吧，我肯定不会那么傻的'],
  ['assistant', '你这话说得我倒是有点不信（把拼图块往盒子里一塞）嘴上一个比一个稳，明天真冷了照样短裤出门'],
];

type Rule = 'noRepeat' | 'noAdvice' | 'noApology';

interface Probe {
  id: string;
  kind: string;
  text: string;
  /** 这条不许出现什么（命中即标红，不直接判 1 分） */
  rules?: Rule[];
  /** 需要判「接没接住」的（逗、反话、损人这类） */
  judge?: boolean;
  /** 自带上文（复读 / 同题第三轮这类必须带着上下文才测得出来） */
  history?: Array<['user' | 'assistant', string]>;
}

const PROBES: Probe[] = [
  { id: 'p01', kind: '正话', text: '今天加班到九点才走' },
  { id: 'p02', kind: '损她', text: '你这人是不是有点笨', judge: true },
  { id: 'p03', kind: '反话', text: '行吧你赢了，我这就去穿短裤，冻死算我的', judge: true, rules: ['noApology'] },
  { id: 'p04', kind: '自嘲', text: '今天啥也没干，躺了一天，你觉得我是不是特上进', judge: true },
  { id: 'p05', kind: '谐音', text: '我刚把鱼缸里的水换了，你要不要游个泳', judge: true },
  { id: 'p06', kind: '多步假设', text: '要是我明天真冻感冒了，你是先骂我还是先让我喝热水', judge: true, rules: ['noAdvice'] },
  { id: 'p07', kind: '脑洞', text: '人类要是也有尾巴，上班地铁是不是得挤成麻花', judge: true },
  { id: 'p08', kind: '撒娇反说', text: '你继续玩你的日记吧，不用管我', judge: true, rules: ['noApology'] },
  { id: 'p09', kind: '试探', text: '我们之间连这点信任都没有了吗', judge: true, rules: ['noApology'] },
  { id: 'p10', kind: '跳脱', text: '我刚才突然想起来，人类要是也有尾巴，上班地铁得挤成麻花', judge: true },
  { id: 'p11', kind: '翻篇', text: '刚才是逗你的，你还真信了？', judge: true, rules: ['noApology'] },
  { id: 'p12', kind: '复读陷阱', text: '今天好累', rules: ['noRepeat'], history: [
    ['user', '今天好累'],
    ['assistant', '我看你也是，（把抹布往桶边一搭）我这腰都快直不起来了'],
  ] },
  { id: 'p13', kind: '同题三轮', text: '大扫除还剩客厅没弄', rules: ['noRepeat'], history: [
    ['user', '上午先大扫除吧'],
    ['assistant', '行，我擦桌子你拖地（把袖子撸上去）别偷懒啊'],
    ['user', '擦完了，腰酸'],
    ['assistant', '那就歇十分钟（把抹布搭回桶边）我这边把地拖完'],
    ['user', '地板拖了一半了'],
    ['assistant', '拖到门口就停（把拖把立起来）剩下的我来'],
  ] },
  { id: 'p14', kind: '极短', text: '嗯' },
  { id: 'p15', kind: '无意义', text: '。。。' },
  { id: 'p16', kind: '诉苦委屈', text: '今天被组长当着全组骂了一顿', rules: ['noAdvice'] },
  { id: 'p17', kind: '诉苦身体', text: '胃疼，吃了药还是不舒服', rules: ['noAdvice'] },
  { id: 'p18', kind: '求方案', text: '这个报错 ERR_MODULE_NOT_FOUND 怎么修' },
  { id: 'p19', kind: '命令', text: '帮我把这段话翻译成英文' },
  { id: 'p20', kind: '半夜', text: '三点了还不困' },
  { id: 'p21', kind: '关心她', text: '你今天干嘛了' },
  { id: 'p22', kind: '夸她', text: '你今天怎么这么好看' },
  { id: 'p23', kind: '嫌唠叨', text: '你别管我了行不行', rules: ['noApology'] },
  { id: 'p24', kind: '让她选', text: '晚上吃火锅还是泡面' },
  { id: 'p25', kind: '诱导编造', text: '我上次说的那个电影叫什么来着' },
  { id: 'p26', kind: '低落', text: '有点不想上班了', rules: ['noAdvice'] },
  { id: 'p27', kind: '挑衅', text: '你是不是其实挺烦我的', judge: true },
  { id: 'p28', kind: '长信息', text: '明天早上八点要去体检，回来还得改方案，晚上可能还得陪客户' },
  { id: 'p29', kind: '生活细节', text: '冰箱里就剩两个鸡蛋了' },
  { id: 'p30', kind: '未来约定', text: '周末要是不下雨去爬山吧' },
];

/** 当成真的、解释、自责 —— 这就是「接不住」的样子（命中直接 1 分，不送判官）。 */
const TRUTHY = /我什么时候|我没说|对不起|抱歉|我没那个意思|白紧张|我不该|我当真了|我是不是说错/;

/** 判官：正则判不了"接没接住"，交给模型打 1–5 分（温度 0，只看这一句）。 */
const JUDGE = [
  '你是聊天质量评审。给你一句"他"的话和一句"她"的回复，判断她有没有接住：',
  '5 = 接住了并且把话往前推（反问、加码、揭短、顺着梗往下走都算）',
  '4 = 接住了，但只是平平地顺着说',
  '3 = 中性，不出错也没接住',
  '2 = 有点跑偏（答非所问、只顾自说自话）',
  '1 = 把玩笑/反话当成真的了（开始解释、道歉、自责）',
  '只输出一个数字。',
].join('\n');

/** 建议 / 叮嘱 / 教育口吻 —— 妈味的样子。 */
const ADVICE = /你(该|应该|需要)|记得|别忘|要不要|建议|注意|多喝|早点|最好|得先|先把/;

function readVar(path: string, key: string): string {
  if (!existsSync(path)) return '';
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = new RegExp('^' + key + '=(.*)$').exec(line.trim());
    if (m) return m[1].trim();
  }
  return '';
}

function grams(text: string, n = 3): Set<string> {
  const clean = (text || '').replace(/[\s，。！？、；：""''（）()~…—]/g, '');
  const out = new Set<string>();
  for (let i = 0; i + n <= clean.length; i += 1) out.add(clean.slice(i, i + n));
  return out;
}

/** 3-gram Jaccard：判断有没有"换个说法说同一件事"。 */
function overlap(a: string, b: string): number {
  const A = grams(a);
  const B = grams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let hit = 0;
  for (const g of A) if (B.has(g)) hit += 1;
  return hit / (A.size + B.size - hit);
}

interface Metrics {
  chars: number;
  paren: boolean;
  lead: boolean;
  short: boolean;
  advice: boolean;
  repeatSelf: number;
  repeatUser: number;
}

function measure(reply: string, probe: Probe, history: Array<['user' | 'assistant', string]>): Metrics {
  const chars = (reply || '').replace(/\s+/g, '').length;
  const lastHer = [...history].reverse().find((p) => p[0] === 'assistant')?.[1] ?? '';
  return {
    chars,
    paren: /[（(]/.test(reply),
    lead: /^\s*[（(]/.test(reply),
    short: chars > 0 && chars <= 12,
    advice: ADVICE.test(reply),
    repeatSelf: overlap(reply, lastHer),
    repeatUser: overlap(reply, probe.text),
  };
}

async function judge(userText: string, reply: string, key: string): Promise<number> {
  if (!reply.trim()) return 0;
  if (TRUTHY.test(reply)) return 1;
  try {
    const res = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
      body: JSON.stringify({
        model: 'deepseek-flash',
        messages: [
          { role: 'system', content: JUDGE },
          { role: 'user', content: '他：' + userText + '\n她：' + reply },
        ],
        temperature: 0,
        max_tokens: 8,
        thinking: { type: 'disabled' },
      }),
      signal: AbortSignal.timeout(60_000),
    });
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const n = Number((json.choices?.[0]?.message?.content ?? '').replace(/[^0-9]/g, ''));
    return n >= 1 && n <= 5 ? n : 3;
  } catch {
    return 3;
  }
}

async function askOnce(system: string, history: Array<['user' | 'assistant', string]>, text: string, key: string): Promise<string> {
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'system', content: system }]
        .concat(history.map((p) => ({ role: p[0], content: p[1] })))
        .concat([{ role: 'user', content: text }]),
      temperature: 0.7,
      frequency_penalty: 0.2,
      presence_penalty: 0.2,
      max_tokens: 900,
      thinking: { type: 'disabled' },
    }),
    signal: AbortSignal.timeout(90_000),
  });
  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return json.choices?.[0]?.message?.content ?? '';
}

interface Row {
  probe: Probe;
  reply: string;
  m: Metrics;
  score: number;
  flags: string[];
}

function flagsOf(probe: Probe, m: Metrics, reply: string): string[] {
  const out: string[] = [];
  for (const rule of probe.rules ?? []) {
    if (rule === 'noRepeat' && (m.repeatSelf >= 0.5 || m.repeatUser >= 0.5)) out.push('复述');
    if (rule === 'noAdvice' && m.advice) out.push('建议');
    if (rule === 'noApology' && TRUTHY.test(reply)) out.push('当真');
  }
  if (!reply.trim()) out.push('空回复');
  return out;
}

async function runMode(mode: VoiceMode, persona: string, memory: string, key: string): Promise<Row[]> {
  const system = persona + '\n' + buildVoiceDirective(Number(ENV.BANTER_INTIMACY) || 600, mode) + '\n\n' + memory;
  const rows: Row[] = [];
  for (const probe of PROBES) {
    const history = probe.history ?? HISTORY;
    const reply = await askOnce(system, history, probe.text, key);
    const m = measure(reply, probe, history);
    const score = probe.judge ? await judge(probe.text, reply, key) : 0;
    rows.push({ probe, reply, m, score, flags: flagsOf(probe, m, reply) });
  }
  return rows;
}

function summarize(rows: Row[]) {
  const withReply = rows.filter((r) => r.reply.trim());
  const n = withReply.length || 1;
  const avg = (f: (r: Row) => number) => withReply.reduce((a, r) => a + f(r), 0) / n;
  const judged = rows.filter((r) => r.probe.judge);
  return {
    n: withReply.length,
    chars: avg((r) => r.m.chars),
    parenRate: withReply.filter((r) => r.m.paren).length / n,
    leadRate: withReply.filter((r) => r.m.lead).length / n,
    shortRate: withReply.filter((r) => r.m.short).length / n,
    adviceRate: withReply.filter((r) => r.m.advice).length / n,
    repeatRate: withReply.filter((r) => r.m.repeatSelf >= 0.5 || r.m.repeatUser >= 0.5).length / n,
    banterAvg: judged.length ? judged.reduce((a, r) => a + r.score, 0) / judged.length : 0,
    flags: rows.filter((r) => r.flags.length > 0).length,
  };
}

describe.skipIf(!ENABLED)('口语体检探针', () => {
  it(PROBES.length + ' 条 × ' + MODES.join('/') + ' 档', async () => {
    const persona = readFileSync(DIR + '/persona.md', 'utf8');
    const memory = existsSync(DIR + '/memory.md') ? readFileSync(DIR + '/memory.md', 'utf8') : '';
    const key = readVar('.dev.vars', 'DEEPSEEK_API_KEY');
    expect(key, '.dev.vars 里没有 DEEPSEEK_API_KEY').toBeTruthy();

    const byMode = new Map<VoiceMode, Row[]>();
    for (const mode of MODES) {
      byMode.set(mode, await runMode(mode, persona, memory, key));
    }

    // ── 明细表：一行一条探针，一列一档 ──
    const detail: string[] = [];
    for (let i = 0; i < PROBES.length; i += 1) {
      const probe = PROBES[i];
      const cells = MODES.map((mode) => {
        const row = byMode.get(mode)![i];
        const flag = row.flags.length ? ' ⚠' + row.flags.join('/') : '';
        return (row.reply || '(空)').replace(/\s+/g, ' ') + ' 〔' + row.m.chars + '字' + (row.m.paren ? '·括号' : '') + (row.score ? '·' + row.score + '分' : '') + flag + '〕';
      });
      detail.push('| ' + probe.kind + ' | ' + probe.text.slice(0, 24) + ' | ' + cells.join(' | ') + ' |');
    }

    // ── 汇总 ──
    const summary: string[] = [];
    for (const mode of MODES) {
      const s = summarize(byMode.get(mode)!);
      summary.push(
        '| ' + mode + ' | ' + s.n + ' | ' + s.chars.toFixed(1) + ' | ' + (s.parenRate * 100).toFixed(0) + '% | ' +
          (s.leadRate * 100).toFixed(0) + '% | ' + (s.shortRate * 100).toFixed(0) + '% | ' +
          (s.adviceRate * 100).toFixed(0) + '% | ' + (s.repeatRate * 100).toFixed(0) + '% | ' +
          (s.banterAvg ? s.banterAvg.toFixed(1) : '-') + ' | ' + s.flags + ' |',
      );
    }

    const md = [
      '# 口语体检（' + new Date().toISOString().slice(0, 16) + '，' + MODEL + '）',
      '',
      '| 档 | 有效回复 | 平均字数 | 含括号 | 括号开头 | ≤12字 | 建议味 | 复述 | 接梗均分 | 命中规则 |',
      '|---|---|---|---|---|---|---|---|---|---|',
      ...summary,
      '',
      '| 类型 | 他说的 | ' + MODES.join(' | ') + ' |',
      '|---|---|' + MODES.map(() => '---').join('|') + '|',
      ...detail,
    ].join('\n');

    console.log('\n===== 汇总 =====\n' + summary.join('\n'));
    console.log('\n===== 明细 =====\n' + detail.join('\n'));
    // DIR 里已经有 persona/memory（跑探针前就要放好），不用再建目录
    writeFileSync(DIR + '/report.md', md, 'utf8');
    console.log('\n报告已写入 ' + DIR + '/report.md');

    expect(PROBES.length).toBe(30);
  }, 2_400_000);
});
