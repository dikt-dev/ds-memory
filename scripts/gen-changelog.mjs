#!/usr/bin/env node
/**
 * 从 git 历史生成 public/changelog.json（修改记录页的数据源）。
 *
 * 为什么不用数据库：每次修改本来就是一个 commit，标题写了「改了什么」，
 * 正文写了「为什么」。再让人手工录一遍，迟早会忘。
 *
 * 用法：node scripts/gen-changelog.mjs [--limit 400] [--out public/changelog.json]
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const limit = Math.min(2000, Math.max(1, Number(argOf('--limit', '400')) || 400));
const out = resolve(process.cwd(), argOf('--out', 'public/changelog.json'));

const TYPE_MAP = {
  feat: 'feat',
  fix: 'fix',
  docs: 'docs',
  refactor: 'refactor',
  perf: 'perf',
  test: 'test',
  chore: 'chore',
  build: 'build',
  style: 'style',
};

/** feat(memory): 铭记系统 → { type, area, title } */
export function parseSubject(subject) {
  const s = (subject ?? '').trim();
  const m = s.match(/^([a-zA-Z]+)(?:\(([^)]+)\))?!?:\s*(.+)$/);
  if (!m) return { type: 'other', area: '', title: s };
  const type = TYPE_MAP[m[1].toLowerCase()] ?? 'other';
  return { type, area: (m[2] ?? '').trim(), title: m[3].trim() };
}

export function toRecord(raw) {
  const { hash, date, subject, body } = raw;
  const { type, area, title } = parseSubject(subject);
  const why = (body ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join(' ')
    .slice(0, 400);
  return { hash: (hash ?? '').slice(0, 7), date, type, area, title, why };
}

function readGitLog() {
  const fmt = '%H%x1f%ad%x1f%s%x1f%b%x1e';
  const text = execFileSync(
    'git',
    ['log', `--max-count=${limit}`, '--no-merges', '--date=format:%Y-%m-%d', `--pretty=format:${fmt}`],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  return text
    .split('\x1e')
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const [hash, date, subject, body] = chunk.split('\x1f');
      return { hash, date, subject, body };
    });
}

function main() {
  const commits = readGitLog();
  const items = commits.map(toRecord).filter((r) => r.title);
  const days = [];
  const index = new Map();
  for (const item of items) {
    if (!index.has(item.date)) {
      const day = { date: item.date, items: [] };
      index.set(item.date, day);
      days.push(day);
    }
    index.get(item.date).items.push(item);
  }
  const payload = {
    generated_at: new Date().toISOString(),
    count: items.length,
    days,
  };
  writeFileSync(out, JSON.stringify(payload, null, 2), 'utf8');
  console.log(`[changelog] ${items.length} 条提交 / ${days.length} 天 → ${out}`);
}

// 只有直接运行才写文件；被 import 时只暴露纯函数（便于测试）。
if (process.argv[1] && process.argv[1].endsWith('gen-changelog.mjs')) main();