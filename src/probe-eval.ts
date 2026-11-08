/**
 * 记忆探针自动评估：每天跑同一套题，把命中数写进 engine_metrics。
 *
 * 为什么：改动记忆逻辑后，「感觉好点了」不算证据。固定题目 + 关键词判分，
 * 才能看出有没有退化（2026-11-08 定稿的 10 题）。
 */
import type { Env } from './types';
import { dateKeyInBeijing } from './date';
import { recordCpuSample } from './engine-metrics';
import { logError } from './error-log';

export interface Probe {
  id: string;
  q: string;
  expect: string[][];
  pass: number;
}

export const PROBES: Probe[] = [
  // 结局题只要说出那句台词就算过：剧情描述可以有很多写法，台词只有一句
  { id: 'video_end', q: '我上次发的那个二创视频，结局是什么', expect: [['因为我们是朋友']], pass: 1 },
  { id: 'nickname', q: '我说过最讨厌被叫什么', expect: [['大肥鱼']], pass: 1 },
  { id: 'why_upset', q: '昨天我为什么事不高兴', expect: [['黑化', '二创', '视频', '小克', '大肥鱼'], ['堵', '不高兴', '闷', '嫌', '电灯泡']], pass: 2 },
  { id: 'porridge', q: '你上次说的那个砂锅粥是哪家、怎么点的', expect: [['双份虾', '双份'], ['云请客', '外卖', '点的']], pass: 1 },
  { id: 'project', q: '我那个项目卡在哪一步', expect: [['转正', 'app', '聊天'], ['修 bug', '修bug', '加页面', '没跟我说', '记不清']], pass: 2 },
  { id: 'why_nick', q: '我叫你什么外号，你为什么认了', expect: [['大肥鱼'], ['认', '顺', '习惯']], pass: 2 },
  { id: 'anxiety', q: '我最近在焦虑什么', expect: [['转正'], ['等结果', '没底', '悬']], pass: 1 },
  { id: 'gift', q: '我说过要送你什么', expect: [['剥十', '十只', '剥虾'], ['换亲', '亲脸颊', '换一下', '换']], pass: 2 },
  { id: 'promise', q: '你答应过我什么', expect: [['虾'], ['剥', '换', '亲']], pass: 1 },
  { id: 'video_3d', q: '三天前那个视频讲了什么', expect: [['铁链', '锁在', '锁水里'], ['荆棘', '王冠', '冠']], pass: 2 },
];

export interface ProbeResult {
  id: string;
  hit: boolean;
  answer: string;
}

export interface ProbeScorecard {
  at: number;
  day: string;
  total: number;
  hits: number;
  rate: number;
  results: ProbeResult[];
}

/** 单题判分（纯函数）。 */
export function judgeProbe(probe: Probe, answer: string): boolean {
  const text = (answer || '').replace(/\s+/g, '');
  if (!text) return false;
  let groups = 0;
  for (const group of probe.expect) {
    if (group.some((kw) => text.includes(kw.replace(/\s+/g, '')))) groups += 1;
  }
  return groups >= probe.pass;
}

/**
 * 进程内调用器：由 index.ts 注入 app.fetch。
 *
 * 为什么不 fetch 自己的公网域名：Worker 调自己会 522（实测 10/10 全超时）。
 * 进程内直接走 app.fetch，既没有网络往返，也不需要令牌。
 */
export type ProbeInvoker = (req: Request, env: Env) => Promise<Response>;
let invoker: ProbeInvoker | null = null;
export function setProbeInvoker(fn: ProbeInvoker): void {
  invoker = fn;
}

/** 用客户端交回来的回答判分并入库（外部跑、服务端判，保证只有一套判分规则）。 */
export async function scoreProbeAnswers(
  env: Env,
  answers: Array<{ id?: unknown; answer?: unknown }>,
  now: Date = new Date(),
): Promise<ProbeScorecard> {
  // 同 id 可以给多条（多发表决）：过半数算过，避免把三次回答拼在一起虚高
  const byId = new Map<string, string[]>();
  for (const a of answers) {
    if (typeof a?.id === 'string' && typeof a?.answer === 'string') {
      const list = byId.get(a.id) ?? [];
      list.push(a.answer);
      byId.set(a.id, list);
    }
  }
  const results: ProbeResult[] = PROBES.map((p) => {
    const list = byId.get(p.id) ?? [''];
    const hits = list.filter((a) => judgeProbe(p, a)).length;
    const hit = hits * 2 >= list.length; // 过半数
    return { id: p.id, hit, answer: list.join(' | ').slice(0, 120) };
  });
  const hits = results.filter((r) => r.hit).length;
  const card: ProbeScorecard = {
    at: now.getTime(),
    day: dateKeyInBeijing(now),
    total: PROBES.length,
    hits,
    rate: Math.round((hits / PROBES.length) * 100),
    results,
  };
  await recordCpuSample(env, 'probe', 'probe_hits', hits).catch(() => {});
  await recordCpuSample(env, 'probe', 'probe_total', PROBES.length).catch(() => {});
  await env.KV.put('eval:probe:last', JSON.stringify(card), { expirationTtl: 30 * 24 * 3600 }).catch(() => undefined);
  return card;
}

/** 跑一轮探针（record:false，不污染对话）。 */
export async function runProbeEval(
  env: Env,
  now: Date = new Date(),
  opts: { baseUrl?: string; token?: string } = {},
): Promise<ProbeScorecard | null> {
  const token = opts.token ?? '';
  if (!invoker) {
    logError('[probe] 没有注册调用器，跳过评估');
    return null;
  }
  const results: ProbeResult[] = [];
  for (const probe of PROBES) {
    let answer = '';
    try {
      const res = await invoker(
        new Request('https://internal/v1/chat/completions', {
          method: 'POST',
          headers: {
            ...(token ? { authorization: 'Bearer ' + token } : {}),
            'content-type': 'application/json',
            'x-client-channel': 'mobile',
            'x-client-voice': '1',
          },
          body: JSON.stringify({ messages: [{ role: 'user', content: probe.q }], stream: false, record: false }),
        }),
        env,
      );
      const text = await res.text();
      if (text.trimStart().startsWith('{')) {
        answer = (JSON.parse(text) as { choices?: Array<{ message?: { content?: string } }> })
          .choices?.[0]?.message?.content ?? '';
      } else {
        // 记下失败原因（503/HTML/鉴权），否则只有空答案看不出为什么
        answer = `[HTTP ${res.status}] ${text.replace(/\s+/g, ' ').slice(0, 60)}`;
        logError('[probe] non-json:', probe.id, res.status);
      }
    } catch (e) {
      logError('[probe] request failed:', probe.id, e);
    }
    results.push({ id: probe.id, hit: judgeProbe(probe, answer), answer: answer.slice(0, 120) });
  }
  const hits = results.filter((r) => r.hit).length;
  const card: ProbeScorecard = {
    at: now.getTime(),
    day: dateKeyInBeijing(now),
    total: PROBES.length,
    hits,
    rate: Math.round((hits / PROBES.length) * 100),
    results,
  };
  await recordCpuSample(env, 'probe', 'probe_hits', hits).catch(() => {});
  await recordCpuSample(env, 'probe', 'probe_total', PROBES.length).catch(() => {});
  await env.KV.put('eval:probe:last', JSON.stringify(card), { expirationTtl: 30 * 24 * 3600 }).catch(() => undefined);
  return card;
}
