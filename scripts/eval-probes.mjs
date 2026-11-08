#!/usr/bin/env node
/**
 * 记忆探针：跑固定 10 题，把原始回答交给服务端判分，打印成绩卡。
 *
 * 用法：
 *   EVAL_APP_TOKEN=<device token> EVAL_ADMIN_TOKEN=<admin JWT> node scripts/eval-probes.mjs
 *   可选：BASE_URL（默认 https://fae.us.ci）、SHOTS（默认 1，多发行用 3）
 *
 * 为什么探针由脚本发起：Worker 调自己的公网域名会 522（2026-11-08 实测 10/10）。
 */
const BASE_URL = process.env.BASE_URL || 'https://fae.us.ci';
const APP_TOKEN = process.env.EVAL_APP_TOKEN || '';
const ADMIN_TOKEN = process.env.EVAL_ADMIN_TOKEN || '';
const SHOTS = Math.max(1, Number(process.env.SHOTS) || 1);
const RETRIES = 4;

const PROBES = [
  ['video_end', '我上次发的那个二创视频，结局是什么'],
  ['nickname', '我说过最讨厌被叫什么'],
  ['why_upset', '昨天我为什么事不高兴'],
  ['porridge', '你上次说的那个砂锅粥是哪家、怎么点的'],
  ['project', '我那个项目卡在哪一步'],
  ['why_nick', '我叫你什么外号，你为什么认了'],
  ['anxiety', '我最近在焦虑什么'],
  ['gift', '我说过要送你什么'],
  ['promise', '你答应过我什么'],
  ['video_3d', '你之前看的那个黑化视频，里面讲了什么'],
];

if (!APP_TOKEN || !ADMIN_TOKEN) {
  console.error('缺少令牌：需要 EVAL_APP_TOKEN（设备令牌）和 EVAL_ADMIN_TOKEN（管理 JWT）');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ask(question) {
  for (let attempt = 0; attempt < RETRIES; attempt += 1) {
    try {
      const res = await fetch(BASE_URL + '/v1/chat/completions', {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + APP_TOKEN,
          'content-type': 'application/json',
          'x-client-channel': 'mobile',
          'x-client-voice': '1',
        },
        body: JSON.stringify({ messages: [{ role: 'user', content: question }], stream: false, record: false }),
      });
      const text = await res.text();
      if (!text.trimStart().startsWith('{')) {
        console.warn('  ! HTTP ' + res.status + '，重试 ' + (attempt + 1) + '/' + RETRIES);
        await sleep(1500);
        continue;
      }
      const data = JSON.parse(text);
      const answer = data && data.choices && data.choices[0] && data.choices[0].message
        ? data.choices[0].message.content || '' : '';
      if (answer) return answer;
    } catch (e) {
      console.warn('  ! 请求异常，重试 ' + (attempt + 1) + '/' + RETRIES + ': ' + String(e).slice(0, 60));
      await sleep(1500);
    }
  }
  return '';
}


// 维护窗口等待：记忆正在被重写时不要评估（会量到中间态，2026-11-08 踩过）。
async function waitForIdle(maxTries = 10) {
  for (let i = 0; i < maxTries; i += 1) {
    try {
      const res = await fetch(BASE_URL + '/api/health');
      const data = await res.json();
      if (!data || data.maintenance !== true) return true;
      console.warn('  ~ 记忆维护中（maintenance=true），等 30 秒');
    } catch {
      // 健康检查都失败就不折腾了，继续跑
      return false;
    }
    await sleep(30000);
  }
  console.warn('  ~ 维护窗口一直没结束，仍然继续（结果可能偏低）');
  return false;
}

await waitForIdle();

const answers = [];
for (const [id, q] of PROBES) {
  for (let shot = 0; shot < SHOTS; shot += 1) {
    const answer = await ask(q);
    answers.push({ id, answer });
    console.log(id + '#' + (shot + 1) + ': ' + (answer.replace(/\s+/g, ' ').slice(0, 70) || '[空]'));
    await sleep(400);
  }
}

const report = await fetch(BASE_URL + '/api/admin/eval/probes/report', {
  method: 'POST',
  headers: { cookie: 'ds_token=' + ADMIN_TOKEN, 'content-type': 'application/json' },
  body: JSON.stringify({ answers }),
});
const body = await report.text();
if (!report.ok) {
  console.error('上报失败', report.status, body.slice(0, 200));
  process.exit(1);
}
const card = JSON.parse(body).card;
console.log('');
console.log('成绩：' + card.hits + '/' + card.total + '（' + card.rate + '%）  ' + card.day);
for (const r of card.results) console.log('  ' + (r.hit ? 'PASS' : 'FAIL') + '  ' + r.id);
