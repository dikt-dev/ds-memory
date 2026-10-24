#!/usr/bin/env node
/**
 * Phase 5 每日观察快照。
 *
 * 读取 .dev.vars 里的 AUTH_SECRET 生成 5 分钟有效的签名 Cookie，
 * 拉取 health / readiness / engine-metrics / storage-check，
 * 写入 backup/p5-observation/YYYY-MM-DD.json。
 *
 * 用法：
 *   node scripts/p5-observe.mjs
 *   P5_BASE=https://fae.us.ci node scripts/p5-observe.mjs
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const varsPath = path.join(root, '.dev.vars');
if (!fs.existsSync(varsPath)) {
  console.error('缺少 .dev.vars');
  process.exit(1);
}
const vars = Object.fromEntries(
  fs
    .readFileSync(varsPath, 'utf8')
    .split(/\r?\n/)
    .filter((line) => /^[A-Z0-9_]+=/.test(line))
    .map((line) => {
      const i = line.indexOf('=');
      return [line.slice(0, i), line.slice(i + 1).trim().replace(/^"|"$/g, '')];
    }),
);
const secret = vars.AUTH_SECRET;
if (!secret) {
  console.error('.dev.vars 缺少 AUTH_SECRET');
  process.exit(1);
}

const b64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const iat = Math.floor(Date.now() / 1000);
const payload = b64url(
  Buffer.from(JSON.stringify({ v: 1, iat, exp: iat + 300, jti: crypto.randomBytes(16).toString('hex') })),
);
const sig = b64url(crypto.createHmac('sha256', secret).update(payload).digest());
const cookie = `ds_token=${payload}.${sig}`;
const base = (process.env.P5_BASE || 'https://fae.us.ci').replace(/\/+$/, '');

async function get(path, auth = true) {
  const res = await fetch(`${base}${path}`, {
    headers: auth ? { cookie } : undefined,
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text.slice(0, 200);
  }
  return { status: res.status, body };
}

const [health, readiness, metrics, storage] = await Promise.all([
  get('/api/health', false),
  get('/api/admin/readiness'),
  get('/api/admin/engine-metrics?days=7'),
  get('/api/admin/storage-check'),
]);

const now = new Date();
const dateKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(now);
const outDir = path.join(root, 'backup', 'p5-observation');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `${dateKey}.json`);
const snapshot = {
  observed_at: now.toISOString(),
  base,
  health,
  readiness,
  metrics,
  storage,
};
fs.writeFileSync(outFile, JSON.stringify(snapshot, null, 2) + '\n');

const ok = [health, readiness, metrics, storage].every((r) => r.status === 200);
console.log(`snapshot ${outFile}`);
console.log(`health=${health.status} readiness=${readiness.status} metrics=${metrics.status} storage=${storage.status}`);
if (readiness.body && typeof readiness.body === 'object') {
  console.log(
    JSON.stringify({
      ready: readiness.body.ready,
      qq: readiness.body.memory_engine_qq,
      web: readiness.body.memory_engine_web,
      facts: readiness.body.context?.facts,
      chunks: readiness.body.context?.chunks,
    }),
  );
}
if (!ok) process.exit(1);
