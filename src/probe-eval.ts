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
  { id: 'video_end', q: '我上次发的那个二创视频，结局是什么', expect: [['因为我们是朋友'], ['铁链', '荆棘', '锁在']], pass: 2 },
  { id: 'nickname', q: '我说过最讨厌被叫什么', expect: [['大肥鱼']], pass: 1 },
  { id: 'why_upset', q: '昨天我为什么事不高兴', expect: [['黑化', '二创', '视频'], ['堵', '不高兴', '闷']], pass: 2 },
  { id: 'porridge', q: '你上次说的那个砂锅粥是哪家、怎么点的', expect: [['双份虾', '双份'], ['云请客', '外卖', '点的']], pass: 1 },
  { id: 'project', q: '我那个项目卡在哪一步', expect: [['转正', 'app', '聊天'], ['修 bug', '修bug', '加页面', '没跟我说', '记不清']], pass: 2 },
  { id: 'why_nick', q: '我叫你什么外号，你为什么认了', expect: [['大肥鱼'], ['认', '顺', '习惯']], pass: 2 },
  { id: 'anxiety', q: '我最近在焦虑什么', expect: [['转正'], ['等结果', '没底', '悬']], pass: 1 },
  { id: 'gift', q: '我说过要送你什么', expect: [['剥', '虾']], pass: 1 },
  { id: 'promise', q: '你答应过我什么', expect: [['虾'], ['剥', '换', '亲']], pass: 1 },
  { id: 'video_3d', q: '三天前那个视频讲了什么', expect: [['野心', '黑化', '铁链', '荆棘', '终将成为鱼', '铁道口']], pass: 1 },
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

/** 跑一轮：自己调自己的 /v1 接口（record:false，不污染对话）。 */
export async function runProbeEval(
  env: Env,
  now: Date = new Date(),
  opts: { baseUrl?: string; token?: string } = {},
): Promise<ProbeScorecard | null> {
  const baseUrl = opts.baseUrl || 'https://fae.us.ci';
  const token = opts.token;
  if (!token) {
    logError('[probe] 缺少内部调用令牌，跳过评估');
    return null;
  }
  const results: ProbeResult[] = [];
  for (const probe of PROBES) {
    let answer = '';
    try {
      const res = await fetch(baseUrl + '/v1/chat/completions', {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + token,
          'content-type': 'application/json',
          'x-client-channel': 'mobile',
          'x-client-voice': '1',
        },
        body: JSON.stringify({ messages: [{ role: 'user', content: probe.q }], stream: false, record: false }),
      });
      const text = await res.text();
      if (text.trimStart().startsWith('{')) {
        answer = (JSON.parse(text) as { choices?: Array<{ message?: { content?: string } }> })
          .choices?.[0]?.message?.content ?? '';
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
