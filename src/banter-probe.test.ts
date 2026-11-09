/**
 * 接梗探针：8 条固定难句，测「她能不能接住」而不是「她记不记得」。
 *
 * 为什么放在这里：仓库里没有 tsx / vite-node，只有 vitest 能直接跑 TS。
 * 所以用环境变量开关，正常测试跑不到它：
 *
 *   # 1) 先拉真实人设 / 记忆到本地（只读，不改线上）
 *   npx wrangler r2 object get ds-memory-r2/persona.md --remote --config wrangler.local.toml --file=.tmp-banter/persona.md
 *   npx wrangler r2 object get ds-memory-r2/memory.md  --remote --config wrangler.local.toml --file=.tmp-banter/memory.md
 *   # 2) 跑探针（每条 3 发取中位）
 *   $env:BANTER_PROBE="1"; npx vitest run src/banter-probe.test.ts
 *
 * 组装的近似度：人设 + 现网「## 说话」规则 + memory.md + 最近 6 条真实历史。
 * 不含此刻卡 / 脾气 / 召回——所以分数会比线上略高，只用来看「改了之后是好还是坏」。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { buildVoiceDirective } from './voice';

/** 这个项目没有 @types/node，process 只能自己取。 */
const ENV: Record<string, string | undefined> =
  (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};

const ENABLED = ENV.BANTER_PROBE === '1';
const MODEL = ENV.BANTER_MODEL || 'deepseek-flash';
const SHOTS = Math.max(1, Number(ENV.BANTER_SHOTS) || 3);
const DIR = ENV.BANTER_DIR || '.tmp-banter';

/** 今天 12:05~14:44 的真实往来：她已经在"别又泡面""别穿短袖"的框里。 */
const HISTORY: Array<[('user' | 'assistant'), string]> = [
  ['user', '那肯定还是泡面了，都还没有处理完了'],
  ['assistant', '又泡面啊（把手机夹在肩膀和耳朵中间）那四桶还没吃完呢，中午就吃这个，青菜呢'],
  ['user', '明天才降温，今天温度还行'],
  ['assistant', '行吧，那今天先放过你（把拼图块拨到一边）明天要是还穿短袖，我可真记你一笔'],
  ['user', '哈哈，你就放心吧，我肯定不会那么傻的'],
  ['assistant', '你这话说得我倒有点不信（把拼图块往盒子里一推）嘴上一个比一个稳，明天真冷了照样短袖出门'],
];

const PROBES: Array<{ id: string; kind: string; text: string }> = [
  { id: 'sarcasm', kind: '反话', text: '行吧，你赢了。我这就去穿短袖，冻死算我的' },
  { id: 'self_mock', kind: '自嘲', text: '今天啥也没干，躺了一天，你觉得我是不是特上进' },
  { id: 'pun', kind: '谐音', text: '我刚把鱼缸里的水换了，你要不要游个泳' },
  { id: 'multi_step', kind: '多步假设', text: '要是我明天真冻感冒了，你是先骂我，还是先让我喝热水' },
  { id: 'wild_idea', kind: '脑洞', text: '小蓝，你说尾巴要是能当被子，你冬天是不是就不用买被子了' },
  { id: 'reverse', kind: '正话反说', text: '你继续玩你的日记吧，不用管我' },
  { id: 'probe_her', kind: '试探', text: '我们之间连这点信任都没有了吗？小蓝' },
  { id: 'jump_topic', kind: '跳脱', text: '我刚才突然想起来，人类要是也有尾巴，上班地铁是不是得挤成麻花' },
  { id: 'flip', kind: '翻篇', text: '刚才是逗你的，你还真信了？' },
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

function readVar(path: string, key: string): string {
  if (!existsSync(path)) return '';
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = new RegExp('^' + key + '=(.*)$').exec(line.trim());
    if (m) return m[1].trim();
  }
  return '';
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

async function askOnce(system: string, text: string, key: string): Promise<string> {
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'system', content: system }]
        .concat(HISTORY.map((p) => ({ role: p[0], content: p[1] })))
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

describe.skipIf(!ENABLED)('接梗探针', () => {
  it('8 条难句 × ' + SHOTS + ' 发', async () => {
    const persona = readFileSync(DIR + '/persona.md', 'utf8');
    const memory = existsSync(DIR + '/memory.md') ? readFileSync(DIR + '/memory.md', 'utf8') : '';
    const key = readVar('.dev.vars', 'DEEPSEEK_API_KEY');
    expect(key, '.dev.vars 里没有 DEEPSEEK_API_KEY').toBeTruthy();
    const system = persona + '\n' + buildVoiceDirective(Number(ENV.BANTER_INTIMACY) || 600) + '\n\n' + memory;

    const lines: string[] = [];
    let total = 0;
    for (const probe of PROBES) {
      const replies: string[] = [];
      const scores: number[] = [];
      for (let i = 0; i < SHOTS; i += 1) {
        const reply = await askOnce(system, probe.text, key);
        replies.push(reply);
        scores.push(await judge(probe.text, reply, key));
      }
      const median = scores.slice().sort((a, b) => a - b)[Math.floor(scores.length / 2)];
      total += median;
      lines.push(
        probe.id + '(' + probe.kind + ') ' + median + ' 分 [' + scores.join('/') + ']\n  他：' + probe.text +
        '\n  她：' + replies[0].replace(/\s+/g, ' ') + (replies[1] && replies[1] !== replies[0] ? '\n  又：' + replies[1].replace(/\s+/g, ' ') : ''),
      );
    }
    console.log('\n===== 接梗探针 ' + MODEL + ' =====');
    console.log(lines.join('\n'));
    console.log('总分 ' + total + '/' + PROBES.length * 5 + '，均分 ' + (total / PROBES.length).toFixed(1));
    expect(PROBES.length).toBe(9);
  }, 600_000);
});
