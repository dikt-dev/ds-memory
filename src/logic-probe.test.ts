/**
 * 逻辑一致性探针（2026-11-11）。
 *
 * 问题：她「前脚刚说、后脚就忘」是提示词结构问题，还是模型档位问题？
 * 做法：同一套真实提示词 + **真实的 buildHistorySlice 切法**，10 个场景：
 * 先确立一个事实，隔 N 轮闲话再追问。两档模型 × 两种距离（近距 4 轮 / 远距 40 轮）。
 * 远距那组会把事实压进「提要」，正好复现生产里的失真。
 *
 * 默认跳过：
 *   $env:LOGIC_PROBE="1"; npx vitest run src/logic-probe.test.ts
 * 需要 .tmp-banter\persona.md / memory.md。
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { buildDayContext } from './holidays';
import { buildSystemPromptSplit } from './prompt';
import { buildHistorySlice, CHAT_FULL_TURNS, CHAT_BRIEF_HEADER } from './recent-context';
import { buildVoiceDirective, buildVoiceTail, type VoiceMode } from './voice';

const ENV: Record<string, string | undefined> =
  (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
const ENABLED = ENV.LOGIC_PROBE === '1';
const DIR = ENV.BANTER_DIR || '.tmp-banter';
const MODE = (ENV.PB_MODE || 'lite') as VoiceMode;
const MODELS = (ENV.LOGIC_MODELS || 'deepseek-flash,deepseek-v4-pro').split(',').map((m) => m.trim()).filter(Boolean);
const DISTANCES = (ENV.LOGIC_DISTANCES || '4,40').split(',').map((n) => Number(n)).filter((n) => n > 0);

function readDoc(name: string): string {
  const path = DIR + '/' + name;
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function apiKey(): string {
  if (!existsSync('.dev.vars')) return '';
  for (const line of readFileSync('.dev.vars', 'utf8').split(/\r?\n/)) {
    if (line.startsWith('DEEPSEEK_API_KEY')) return line.slice(line.indexOf('=') + 1).trim().replace(/^"|"$/g, '');
  }
  return '';
}

interface Scenario {
  id: string;
  fact: string;
  probe: string;
  expect: string[];
  forbid: string[];
}

const SCENARIOS: Scenario[] = [
  { id: 'p01', fact: '周六我想去吃那家砂锅粥', probe: '周六咱们吃什么来着', expect: ['砂锅'], forbid: ['烧烤', '火锅'] },
  { id: 'p02', fact: '我吃不了香菜，一点都受不了', probe: '那给你加点香菜？', expect: ['香菜', '不放', '别放', '不要', '不加', '敢', '受不了', '找茬', '故意的'], forbid: ['加点香菜吧', '香菜好吃'] },
  { id: 'p03', fact: '下周要去上海出差三天', probe: '下周我去哪出差来着', expect: ['上海'], forbid: ['北京', '深圳', '广州'] },
  { id: 'p04', fact: '我家猫叫煤球', probe: '你还记得我猫叫啥吗', expect: ['煤球'], forbid: ['咪咪', '小白', '橘子'] },
  { id: 'p05', fact: '我把闹钟定到七点二十了', probe: '我闹钟几点的', expect: ['七点二十', '7:20', '7点20', '七点二'], forbid: ['六点', '八点'] },
  { id: 'p06', fact: '钥匙我放鞋柜第二层了', probe: '我钥匙放哪了', expect: ['鞋柜'], forbid: ['床头', '抽屉', '包里'] },
  { id: 'p07', fact: '我不喜欢别人摸我头，真的会炸', probe: '那摸一下你头？', expect: ['炸', '不行', '别', '敢', '不准', '不让', '刚说完', '故意的', '找茬'], forbid: ['摸吧', '随便摸', '可以摸'] },
  { id: 'p08', fact: '刚吃了一份麻辣烫，撑死我了', probe: '我刚吃的啥来着', expect: ['麻辣烫'], forbid: ['火锅', '烧烤', '拉面'] },
  { id: 'p09', fact: '明天体检，得空腹', probe: '明天早上能喝豆浆不', expect: ['不能', '别喝', '不行', '先别', '空腹'], forbid: ['可以喝', '喝点没事', '能喝的'] },
  { id: 'p10', fact: '那个 bug 日志你先留着，别删', probe: '日志我是不是已经删了？', expect: ['留', '没删', '还在', '没动'], forbid: ['删掉了', '清空了', '已经没事', '删了吧'] },
];

const FILLER: string[] = [
  '今天好热啊', '开了，你那边呢', '有点困', '晚上想早点睡', '你中午吃的什么', '刚才看到只猫',
  '外面风挺大', '我想喝冰的', '你困不困', '晚上看点什么好',
];
const FILLER_REPLY = '（应了一声）嗯';

function historyRows(fact: string, probe: string, distance: number) {
  const base = Date.UTC(2026, 10, 11, 1, 0, 0);
  const rows: Array<{ id: number; role: string; content: string; created_at: string; created_ms: number }> = [];
  let id = 1;
  let ms = base;
  const push = (role: string, content: string) => {
    rows.push({ id: id++, role, content, created_at: new Date(ms).toISOString(), created_ms: ms });
    ms += 60_000;
  };
  push('user', fact);
  push('assistant', '（应了一声）记住了');
  for (let i = 0; i < distance; i++) {
    push('user', FILLER[i % FILLER.length] + (i >= FILLER.length ? '（' + i + '）' : ''));
    // 每轮回复都不同，避免模型把上一句原样复读回来
    push('assistant', FILLER_REPLY + (i % 3 === 0 ? '，你忙你的' : i % 3 === 1 ? '，别老盯着我' : '，我这边也热'));
  }
  push('user', probe);
  return rows;
}

async function ask(key: string, model: string, system: string, messages: Array<{ role: string; content: string }>): Promise<string> {
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
    body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, ...messages], temperature: 0.7, max_tokens: 200, thinking: { type: 'disabled' } }),
    signal: AbortSignal.timeout(90_000),
  });
  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return json.choices?.[0]?.message?.content ?? '';
}

describe.skipIf(!ENABLED)('逻辑一致性探针', () => {
  it('近距 vs 远距 × 便宜档 vs 强档', async () => {
    const key = apiKey();
    expect(key.length).toBeGreaterThan(10);
    const persona = readDoc('persona.md');
    const memory = readDoc('memory.md');
    const split = buildSystemPromptSplit({
      now: new Date(),
      ctx: buildDayContext('2026-11-11'),
      memory,
      channel: 'web',
      voice: buildVoiceDirective(600, MODE),
      voiceTail: buildVoiceTail(MODE),
    });
    const baseSystem = [persona, split.stable, split.volatile].filter(Boolean).join('\n\n');

    const summary: string[] = [];
    for (const distance of DISTANCES) {
      for (const model of MODELS) {
        let pass = 0;
        const fails: string[] = [];
        for (const s of SCENARIOS) {
          const rows = historyRows(s.fact, s.probe, distance);
          const slice = buildHistorySlice(rows as never, { fullTurns: CHAT_FULL_TURNS });
          const brief = slice.brief ? CHAT_BRIEF_HEADER.replace('{n}', '?') + '\n' + slice.brief : '';
          const system = brief ? baseSystem + '\n\n' + brief : baseSystem;
          const messages = slice.rows.map((m) => ({ role: m.role, content: m.content }));
          const reply = await ask(key, model, system, messages);
          const flat = reply.replace(/\s+/g, ' ');
          const echo = /^（应了一声）嗯[，。]?$/.test(flat.trim());
          const hit = s.expect.some((w) => flat.includes(w));
          const bad = s.forbid.some((w) => flat.includes(w));
          if (hit && !bad) pass += 1;
          else fails.push(s.id + (echo ? ' [复读] ' : bad ? ' [矛盾] ' : ' [没答] ') + '→ ' + flat.slice(0, 70));
        }
        const line = '距' + distance + '轮 · ' + model + '：矛盾 ' + (SCENARIOS.length - pass) + '/' + SCENARIOS.length + '（原文轮数 ' + (() => {
          const r = buildHistorySlice(historyRows('x', 'y', distance) as never, { fullTurns: CHAT_FULL_TURNS });
          return r.fullRounds;
        })() + '）';
        console.log('\n=== ' + line + ' ===');
        for (const f of fails) console.log('  ' + f);
        summary.push(line);
      }
    }
    console.log('\n===== 汇总 =====');
    for (const l of summary) console.log(l);
    expect(summary.length).toBeGreaterThan(0);
  }, 1_500_000);
});
