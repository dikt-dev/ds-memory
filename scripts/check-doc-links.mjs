#!/usr/bin/env node
/**
 * 文档相对链接检查。
 *
 * 用法（任选其一）：
 *   node scripts/check-doc-links.mjs                 # 默认扫当前仓库 docs/
 *   node scripts/check-doc-links.mjs ../docs docs   # 扫指定目录（可多个）
 *   node scripts/check-doc-links.mjs README.md      # 也可以直接给文件
 *
 * 判定：跳过 http(s)/mailto/#锚点/绝对路径；其余按「相对本文件的路径」解析，
 * 目标不存在即算坏链。退出码 1 表示有坏链，能直接挂到 CI。
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';

const args = process.argv.slice(2);
const roots = args.length ? args : ['docs'];

const mdFiles = [];
function walk(p) {
  const st = statSync(p, { throwIfNoEntry: false });
  if (!st) return;
  if (st.isFile()) {
    if (p.endsWith('.md')) mdFiles.push(p);
    return;
  }
  for (const name of readdirSync(p)) {
    if (name === 'node_modules' || name === 'build' || name === 'dist') continue;
    walk(join(p, name));
  }
}
for (const r of roots) walk(resolve(r));

const LINK = /\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const SKIP = /^(https?:|mailto:|tel:|#|\/)/i;

let broken = 0;
let checked = 0;
for (const file of mdFiles) {
  const text = readFileSync(file, 'utf8');
  let m;
  LINK.lastIndex = 0;
  while ((m = LINK.exec(text))) {
    const raw = m[1];
    if (SKIP.test(raw)) continue;
    const target = decodeURI(raw.split('#')[0].split('?')[0]);
    if (!target) continue;
    checked += 1;
    const abs = resolve(dirname(file), target);
    if (!existsSync(abs)) {
      const line = text.slice(0, m.index).split('\n').length;
      console.log(`  ✗ ${file.replace(process.cwd() + '\\', '')}:${line}  ->  ${raw}`);
      broken += 1;
    }
  }
}

console.log(`扫描 ${mdFiles.length} 个 md / ${checked} 条相对链接，坏链 ${broken} 条`);
process.exit(broken === 0 ? 0 : 1);
