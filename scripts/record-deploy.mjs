#!/usr/bin/env node
/**
 * 记一次部署：往 public/deploys.json 追加 { at, date, hash, note }。
 *
 * 为什么单独记：git 里只有「代码改了」，没有「什么时候上的线」。
 * 出问题时第一个要回答的就是「那次改动上线了吗、什么时候上的」。
 *
 * 用法：node scripts/record-deploy.mjs --note "19 批：铭记 + 脾气 + 情绪调优"
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const file = resolve(process.cwd(), 'public/deploys.json');
const note = argOf('--note', '');
const now = new Date();
const bj = new Date(now.getTime() + 8 * 3600_000);
const date = bj.toISOString().slice(0, 10);
const at = bj.toISOString().slice(0, 16).replace('T', ' ');
let hash = '';
try {
  hash = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
} catch {
  hash = '';
}

const payload = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
const list = Array.isArray(payload) ? payload : (payload.deploys ?? []);
// 同一次提交同一天只记一条，避免重试时刷屏
const dup = list.find((d) => d.hash === hash && d.date === date);
if (dup) {
  dup.at = at;
  if (note) dup.note = note;
  console.log('[deploy] 已更新今天的记录：' + date + ' ' + hash);
} else {
  list.push({ at, date, hash, note });
  console.log('[deploy] 新增部署记录：' + date + ' ' + hash);
}
writeFileSync(file, JSON.stringify(list, null, 2), 'utf8');
