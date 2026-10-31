#!/usr/bin/env node
/**
 * 排查「写了但没接线」：扫 src 里所有 export 函数，按引用来源分三档。
 *
 *   A 完全无引用   —— 纯废弃，可以删
 *   B 只有测试引用 —— 生产路径没用到，多半是「两套实现」或兼容壳
 *   C 只有脚本/文档引用 —— 留着是给人用的工具，不影响线上
 *
 * 用法：npm run dead-code
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(root, 'src');
const files = readdirSync(srcDir).filter((f) => f.endsWith('.ts'));
const all = files.map((base) => ({ base, text: readFileSync(join(srcDir, base), 'utf8') }));
const runtime = all.filter((f) => !f.base.endsWith('.test.ts') && !f.base.endsWith('.d.ts'));

const defs = [];
for (const f of runtime) {
  const re = /export (?:async )?function (\w+)/g;
  let m;
  while ((m = re.exec(f.text))) {
    defs.push({ name: m[1], base: f.base, line: f.text.slice(0, m.index).split('\n').length });
  }
}

const buckets = { dead: [], testsOnly: [], docOnly: [] };
const docText = readFileSync(join(root, 'docs', 'STATUS.md'), 'utf8');

for (const d of defs) {
  const word = new RegExp(`\\b${d.name}\\b`, 'g');
  let rt = 0;
  let tt = 0;
  for (const f of all) {
    const c = (f.text.match(word) || []).length;
    if (f.base.endsWith('.test.ts')) tt += c;
    else rt += c;
  }
  rt -= 1; // 定义本身
  if (rt <= 0 && tt === 0) {
    if (new RegExp(word.source).test(docText)) buckets.docOnly.push(d);
    else buckets.dead.push(d);
  } else if (rt <= 0) {
    buckets.testsOnly.push({ ...d, tests: tt });
  }
}

const show = (label, arr) => {
  console.log(`\n${label} (${arr.length})`);
  for (const d of arr) console.log(`  ${d.base}:${d.line}  ${d.name}`);
};

show('A 完全无引用', buckets.dead);
show('B 只有测试引用', buckets.testsOnly);
show('C 只在文档里提到', buckets.docOnly);
console.log(`\n共扫描 ${defs.length} 个导出函数`);
