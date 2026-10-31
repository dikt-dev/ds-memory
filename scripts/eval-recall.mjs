#!/usr/bin/env node
// 真实记忆上的召回对照：同一句话同时跑 legacy 与 next（服务端 compare 接口）。
// 用法（ds-memory 目录）：node scripts/eval-recall.mjs [--only g2] [--verbose]
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

const BASE = process.env.ENGINE_BASE ?? 'https://fae.us.ci';
const EVAL_DIR = path.join(process.cwd(), 'docs/eval');

const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const verbose = args.includes('--verbose');
// 用例多了以后必须限速：连续打会把 Worker 打到 503，样本缺口直接污染结论。
const delayMs = args.includes('--delay') ? Number(args[args.indexOf('--delay') + 1]) : 800;
const skip = args.includes('--skip') ? Number(args[args.indexOf('--skip') + 1]) : 0;

function loadSecret() {
  const text = fs.readFileSync(path.join(process.cwd(), '.dev.vars'), 'utf8');
  const line = text.split(/\r?\n/).find((l) => l.startsWith('AUTH_SECRET='));
  if (!line) throw new Error('AUTH_SECRET not found in .dev.vars');
  return line.split('=').slice(1).join('=').trim();
}

function authCookie(secret) {
  const now = Math.floor(Date.now() / 1000);
  const payload = { v: 1, iat: now, exp: now + 3600, jti: crypto.randomBytes(16).toString('hex') };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return 'ds_token=' + body + '.' + sig;
}

/** 优先用真实集（.local，不入库），没有就退回合成集。 */
function loadCases() {
  const local = path.join(EVAL_DIR, 'golden-memory.local.json');
  const synth = path.join(EVAL_DIR, 'golden-memory.json');
  const file = fs.existsSync(local) ? local : synth;
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return {
    file: path.basename(file),
    cases: raw.cases.map((c) => ({
      id: c.id,
      query: c.query,
      expect: c.expected_any ?? c.expect ?? [],
      avoid: c.avoid ?? [],
      maxItems: c.max_items ?? c.maxItems ?? null,
      section: c.section ?? c.group ?? '',
      notes: c.notes ?? '',
    })),
  };
}

function score(item, text, count) {
  const lower = text.toLowerCase();
  const hits = item.expect.filter((e) => lower.includes(String(e).toLowerCase()));
  const bad = item.avoid.filter((e) => lower.includes(String(e).toLowerCase()));
  const overLimit = item.maxItems != null && count > item.maxItems;
  const hit = item.expect.length === 0 ? !overLimit : hits.length > 0 && !overLimit;
  return { hit, hits, bad, overLimit, count };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, cookie, tries = 5) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { cookie }, signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error('http ' + res.status);
      return await res.json();
    } catch (err) {
      last = err;
      await sleep(1200 * (i + 1));
    }
  }
  throw last;
}

const { file, cases } = loadCases();
const items = cases
  .filter((c) => !only || c.section.includes(only) || c.id.startsWith(only))
  .slice(skip);
const cookie = authCookie(loadSecret());

console.log('数据集 ' + file + '  用例 ' + items.length + '\n');
const rows = [];
for (const item of items) {
  const url = BASE + '/api/admin/memory/recall?compare=1&q=' + encodeURIComponent(item.query);
  let j;
  try {
    j = await getJson(url, cookie);
  } catch (err) {
    console.log(item.id.padEnd(7) + '✗ 请求失败: ' + err.message);
    continue;
  }
  const l = score(item, j.legacy?.text ?? '', j.legacy?.items ?? 0);
  const n = score(item, j.next?.text ?? '', j.next?.items ?? 0);
  rows.push({ item, legacy: l, next: n });
  const mark = (s) => (s.hit ? '✓' : '✗');
  console.log(
    item.id.padEnd(7) + mark(l) + 'L' + String(l.count).padStart(2) +
    '  ' + mark(n) + 'N' + String(n.count).padStart(2) +
    '  ' + item.query,
  );
  if (verbose && !n.hit) console.log('    next: ' + (j.next?.text ?? '').replace(/\n/g, ' | ').slice(0, 260));
  await sleep(delayMs);
}

const hit = (k) => rows.filter((r) => r[k].hit).length;
const avg = (k) => (rows.reduce((a, r) => a + r[k].count, 0) / Math.max(1, rows.length)).toFixed(1);
const bad = (k) => rows.filter((r) => r[k].bad.length > 0 || r[k].overLimit).length;

console.log('\n样本 ' + rows.length + ' 条');
for (const k of ['legacy', 'next']) {
  console.log(
    (k === 'legacy' ? 'legacy' : 'next  ') + '  命中 ' + hit(k) + '/' + rows.length +
    '  平均召回 ' + avg(k) + ' 条  误召/越界 ' + bad(k),
  );
}
fs.writeFileSync(path.join(EVAL_DIR, 'last-run.json'), JSON.stringify({ at: new Date().toISOString(), file, rows }, null, 2));
console.log('明细 → docs/eval/last-run.json');
