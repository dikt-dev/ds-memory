#!/usr/bin/env node
// 生成访问口令哈希（格式 salt:hash，存入 ACCESS_PASSWORD_HASH）。
// 用法：node scripts/hash-password.mjs <口令> [盐]
import { createHash, randomBytes } from 'node:crypto';

const pw = process.argv[2];
if (!pw) {
  console.error('用法: node scripts/hash-password.mjs <口令> [盐]');
  console.error('生成后：本地写入 .dev.vars；线上执行 `wrangler secret put ACCESS_PASSWORD_HASH`。');
  process.exit(1);
}
const salt = process.argv[3] ?? randomBytes(16).toString('hex');
const hash = createHash('sha256').update(`${salt}:${pw}`).digest('hex');
console.log(`ACCESS_PASSWORD_HASH=${salt}:${hash}`);
