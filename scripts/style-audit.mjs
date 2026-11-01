#!/usr/bin/env node
/**
 * 活人感体检：统计最近 N 条回复的长度、括号动作、追问、口癖。
 *
 * 用法：
 *   npm run style-audit              # 从 D1 拉最近 200 条
 *   npm run style-audit -- --n 500   # 指定条数
 *   npm run style-audit -- --file dump.json   # 用本地导出（wrangler --json 的输出）
 *
 * 为什么要有这个：改提示词不能靠感觉。「平均长度从 147 掉到 50」
 * 这种数字才是验收标准，也是下一步该改哪一条的依据。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const limit = Number(argOf('--n', '200'));
const file = argOf('--file', '');

function loadRows() {
  if (file) {
    const buf = readFileSync(file);
    const raw = buf[0] === 0xff && buf[1] === 0xfe ? buf.toString('utf16le') : buf.toString('utf8');
    const start = raw.indexOf('[');
    if (start < 0) throw new Error('文件里没有 JSON 数组：' + file);
    return JSON.parse(raw.slice(start))[0].results;
  }
  const sql =
    `SELECT content FROM messages WHERE role='assistant' ORDER BY id DESC LIMIT ${limit}`;
  const cmd =
    'npx wrangler d1 execute ds-memory-db -c wrangler.local.toml --remote --json --command ' +
    JSON.stringify(sql);
  const out = execFileSync(cmd, {
    encoding: 'utf8',
    shell: true,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID || '1d0cedf164665fcc2ff558ec4a0564a2' },
  });
  const start = out.indexOf('[');
  return JSON.parse(out.slice(start))[0].results;
}

const rows = loadRows();
const texts = rows.map((r) => String(r.content ?? ''));
if (texts.length === 0) {
  console.log('没有消息可统计。');
  process.exit(0);
}

const pct = (n) => ((n / texts.length) * 100).toFixed(0) + '%';
const lens = texts.map((t) => t.length).sort((a, b) => a - b);
const avg = Math.round(lens.reduce((a, b) => a + b, 0) / lens.length);
const at = (q) => lens[Math.min(lens.length - 1, Math.floor(lens.length * q))];

const hasParen = texts.filter((t) => /[（(]/.test(t)).length;
const opensParen = texts.filter((t) => /^\s*[（(]/.test(t)).length;
const endsAsk = texts.filter((t) => /[？?]\s*$/.test(t)).length;
const veryShort = texts.filter((t) => t.length <= 12).length;
const long = texts.filter((t) => t.length >= 120).length;

const counts = new Map();
for (const t of texts) {
  const clean = t.replace(/[（(][^）)]*[）)]/g, '');
  for (const m of clean.matchAll(/[\u4e00-\u9fa5]{2,4}/g)) {
    counts.set(m[0], (counts.get(m[0]) ?? 0) + 1);
  }
}
const top = [...counts.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 12);

console.log(`\n样本 ${texts.length} 条\n`);
console.log(`长度      平均 ${avg} 字｜中位 ${at(0.5)}｜p90 ${at(0.9)}｜最长 ${lens[lens.length - 1]}`);
console.log(`段落形态  ≥120 字 ${pct(long)}｜≤12 字 ${pct(veryShort)}`);
console.log(`动作描写  含括号 ${pct(hasParen)}｜括号开头 ${pct(opensParen)}`);
console.log(`追问收尾  以问号结尾 ${pct(endsAsk)}`);
console.log('\n口癖 Top：');
for (const [w, n] of top) console.log(`  ${w.padEnd(6)} ×${n}`);
console.log('\n参考：长度中位 30~50、括号 <40%、≤12 字 >15% 时，读起来最像人在打字。\n');
