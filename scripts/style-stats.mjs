#!/usr/bin/env node
/**
 * 说话风格体检：拿 wrangler d1 的 JSON 输出算「像不像人在发微信」。
 *
 * 用法：
 *   $env:CLOUDFLARE_ACCOUNT_ID="..."
 *   npx wrangler d1 execute ds-memory-db --remote --config wrangler.local.toml \
 *     --command "SELECT content FROM messages WHERE role='assistant' ORDER BY id DESC LIMIT 120" \
 *     --json > D:\\tmp\\msgs.json
 *   node scripts/style-stats.mjs D:\\tmp\\msgs.json
 *
 * 指标与含义（越低越自然）：
 *   paren率    以（动作）开头的比例，> 40% 像念剧本
 *   paren/条   平均括号动作数，> 1.5 明显偏多
 *   自称/条    「本小姐」平均次数，> 1.5 就是口头禅变成口癖
 *   问句尾     以问句收尾的比例，> 15% 会显得像在采访
 */
import { readFileSync } from 'node:fs';

const path = process.argv[2];
if (!path) {
  console.error('用法: node scripts/style-stats.mjs <wrangler --json 输出文件>');
  process.exit(1);
}

const raw = readFileSync(path, 'utf8');
const start = raw.indexOf('[');
if (start < 0) {
  console.error('没找到 JSON 数组');
  process.exit(1);
}
const rows = JSON.parse(raw.slice(start))[0]?.results ?? [];
const texts = rows.map((r) => String(r.content ?? '')).filter(Boolean);
if (texts.length === 0) {
  console.error('没有消息');
  process.exit(1);
}

const n = texts.length;
const pct = (k) => `${Math.round((k / n) * 100)}%`;
const sum = (f) => texts.reduce((s, t) => s + f(t), 0);

const paren = /[（(][^）)]{1,60}[）)]/g;
const stats = {
  样本: n,
  平均字数: Math.round(sum((t) => t.length) / n),
  括号开头率: pct(texts.filter((t) => /^[（(]/.test(t.trim())).length),
  括号每条: (sum((t) => (t.match(paren) ?? []).length) / n).toFixed(2),
  自称每条: (sum((t) => (t.match(/本小姐/g) ?? []).length) / n).toFixed(2),
  问句收尾率: pct(texts.filter((t) => /[？?]\s*$/.test(t.trim())).length),
  破折号每条: (sum((t) => (t.match(/——/g) ?? []).length) / n).toFixed(2),
  清单率: pct(texts.filter((t) => /第[一二三]|一是|二是/.test(t)).length),
  自我剖析率: pct(texts.filter((t) => /不是.{1,12}[，,]?是/.test(t)).length),
};

console.log(stats);
const warn = [];
if (Number(stats['括号每条']) > 1.5) warn.push('括号动作偏多');
if (Number(stats['自称每条']) > 1.5) warn.push('自称偏频');
if (stats['问句收尾率'] !== '0%' && parseInt(stats['问句收尾率']) > 15) warn.push('问句收尾偏多');
if (warn.length) console.log('\n注意：', warn.join('、'));
else console.log('\n各项都在自然区间。');
