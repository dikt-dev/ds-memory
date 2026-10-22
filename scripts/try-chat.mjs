#!/usr/bin/env node
/**
 * 本地试聊脚本：走一遍「登录 → /api/chat SSE → 打印回复与字数」。
 *
 * 用途：调提示词（尤其是回复长度）时，不用开浏览器就能看到真实回复。
 *
 * 用法：
 *   pnpm dev                                   # 另开一个终端跑本地服务
 *   node scripts/try-chat.mjs "在干嘛"
 *   node scripts/try-chat.mjs "帮我看看这个报错" --port 8787 --password dev-2026
 *
 * 依赖：.dev.vars 里填好真实的 DEEPSEEK_API_KEY。
 * 注意：默认连本地服务（--local，空库）。想用线上那份真实记忆，请先 pnpm dev --remote。
 */
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const message = args.find((a) => !a.startsWith('--')) ?? '在干嘛';
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const port = flag('port', '8787');
const base = `http://127.0.0.1:${port}`;

/** 从 .dev.vars 读取口令哈希（只用于校验配置是否就绪，明文口令需另外提供）。 */
function readDevVars() {
  try {
    return Object.fromEntries(
      readFileSync('.dev.vars', 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#') && l.includes('='))
        .map((l) => {
          const i = l.indexOf('=');
          return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
        }),
    );
  } catch {
    return {};
  }
}

const password = flag('password', 'dev-2026');
const vars = readDevVars();

if (!vars.DEEPSEEK_API_KEY || vars.DEEPSEEK_API_KEY.includes('REPLACE')) {
  console.error('✗ .dev.vars 里的 DEEPSEEK_API_KEY 还没填真实值，先去填上再试。');
  process.exit(1);
}

const login = await fetch(`${base}/api/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ password }),
});

if (!login.ok) {
  console.error(`✗ 登录失败（HTTP ${login.status}）：${await login.text()}`);
  console.error('  如果改过 ACCESS_PASSWORD_HASH，用 --password 传入对应明文。');
  process.exit(1);
}

const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];

const res = await fetch(`${base}/api/chat`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify({ content: message }),
});

if (!res.ok) {
  console.error(`✗ /api/chat 失败（HTTP ${res.status}）：${await res.text()}`);
  process.exit(1);
}

let reply = '';
let usage = null;
const reader = res.body.getReader();
const decoder = new TextDecoder();
let carry = '';

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  carry += decoder.decode(value, { stream: true });
  const lines = carry.split('\n');
  carry = lines.pop() ?? '';
  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith('data:')) continue;
    const payload = t.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const obj = JSON.parse(payload);
      if (obj.event === 'usage') {
        usage = obj;
        continue;
      }
      const delta = obj.choices?.[0]?.delta?.content;
      if (typeof delta === 'string') reply += delta;
    } catch {
      /* 忽略注释/心跳行 */
    }
  }
}

const text = reply.trim();
console.log('\n—— 回复 ——');
console.log(text || '（空）');
console.log('\n—— 统计 ——');
console.log(`字数：${[...text].length}   行数：${text.split('\n').length}`);
console.log(`含列表/标题/加粗：${/^[-*]\s|^#{1,3}\s|\*\*/m.test(text) ? '是（可能需要压）' : '否'}`);
if (usage) console.log(`本次费用：¥${Number(usage.cost_rmb ?? 0).toFixed(6)}`);
