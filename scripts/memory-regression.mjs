#!/usr/bin/env node
/**
 * 记忆回归骨架：只读 /api/admin/memory/recall，不写记忆、不调模型。
 *
 * 用法：
 *   node scripts/memory-regression.mjs
 *   node scripts/memory-regression.mjs --cases scripts/memory-regression-cases.json
 *
 * 环境：
 *   DS_BASE_URL  默认 https://fae.us.ci
 *   DS_COOKIE    已有登录 cookie；不填则用 .dev.vars 的 AUTH_SECRET 临时签名
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const args = process.argv.slice(2);
const casesPath = path.resolve(
  root,
  args.includes('--cases') ? args[args.indexOf('--cases') + 1] : 'scripts/memory-regression-cases.json',
);
const baseUrl = (process.env.DS_BASE_URL || 'https://fae.us.ci').replace(/\/$/, '');

function cookieFromDevVars() {
  const file = path.join(root, '.dev.vars');
  if (!fs.existsSync(file)) return '';
  const text = fs.readFileSync(file, 'utf8');
  const match = text.match(/^AUTH_SECRET=(.+)$/m);
  if (!match) return '';
  const secret = match[1].trim();
  const b64url = (buf) =>
    Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const iat = Math.floor(Date.now() / 1000);
  const payload = b64url(
    JSON.stringify({
      v: 1,
      iat,
      exp: iat + 300,
      jti: crypto.randomBytes(16).toString('hex'),
    }),
  );
  const sig = b64url(crypto.createHmac('sha256', secret).update(payload).digest());
  return `ds_token=${payload}.${sig}`;
}

const cookie = process.env.DS_COOKIE || cookieFromDevVars();
if (!cookie) {
  console.error('缺少 DS_COOKIE 或 .dev.vars 的 AUTH_SECRET');
  process.exit(2);
}
if (!fs.existsSync(casesPath)) {
  console.error(`cases not found: ${casesPath}`);
  process.exit(2);
}

const cases = JSON.parse(fs.readFileSync(casesPath, 'utf8'));
if (!Array.isArray(cases) || cases.length === 0) {
  console.error('cases 为空');
  process.exit(2);
}

let failed = 0;
const results = [];
for (const test of cases) {
  const url = `${baseUrl}/api/admin/memory/recall?q=${encodeURIComponent(test.query)}`;
  try {
    const res = await fetch(url, { headers: { cookie } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      failed += 1;
      results.push({ id: test.id, ok: false, error: `HTTP ${res.status}` });
      continue;
    }
    const text = (data.items ?? []).map((x) => x.content || '').join('\n');
    const expectAny = test.expect_any ?? [];
    const expectAll = test.expect_all ?? [];
    const forbidAny = test.forbid_any ?? [];
    const missingAny = expectAny.length > 0 && !expectAny.some((x) => text.includes(x));
    const missingAll = expectAll.filter((x) => !text.includes(x));
    const forbidden = forbidAny.filter((x) => text.includes(x));
    const tooManyLinked = Number(data.linked || 0) > Number(test.max_linked ?? 2);
    const ok = !missingAny && missingAll.length === 0 && forbidden.length === 0 && !tooManyLinked;
    if (!ok) failed += 1;
    results.push({
      id: test.id,
      ok,
      picked: data.picked,
      linked: data.linked,
      missing_any: missingAny,
      missing_all: missingAll,
      forbidden,
      too_many_linked: tooManyLinked,
    });
  } catch (e) {
    failed += 1;
    results.push({ id: test.id, ok: false, error: String(e) });
  }
}

console.log(JSON.stringify({ suite: path.basename(casesPath), total: cases.length, failed, results }, null, 2));
if (failed > 0) process.exitCode = 1;
