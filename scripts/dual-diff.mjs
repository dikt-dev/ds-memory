/**
 * legacy / next 一次性内容比对。
 *
 * 不挂在 Worker 里：这是一次性的诊断，不是常驻功能。
 * 数量对账（memory-dual）负责回归检测，这个脚本负责回答「差在哪几条」。
 *
 * 用法：
 *   node scripts/dual-diff.mjs            # 摘要 + 前 20 条差异
 *   node scripts/dual-diff.mjs --all      # 打全部差异
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ALL = process.argv.includes('--all');
const WRANGLER = process.platform === 'win32' ? 'npx.cmd' : 'npx';

function d1(sql) {
  // 直接用 node 跑 wrangler 的入口：不经过 shell，SQL 作为一个参数原样传进去。
  // --file 只回统计信息，不回结果集，所以只能走 --command。
  const out = execFileSync(
    process.execPath,
    ['node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', 'ds-memory-db', '-c', 'wrangler.local.toml', '--remote', '--json', '--command', sql],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  const clean = out.replace(/\u001b\[[0-9;]*m/g, '');
  const at = clean.lastIndexOf('[{');
  const parsed = JSON.parse(clean.slice(at !== -1 ? at : clean.indexOf('[')));
  return (parsed[0]?.results ?? []);
}

/** 归一化：只抹掉「写法差异」，不抹掉「内容差异」。 */
function norm(s) {
  return String(s ?? '')
    .replace(/\[\d{2}-\d{2}-\d{2}\]/g, '')      // 行首日期标记
    .replace(/\s+/g, '')                            // 空白
    .replace(/[，,。.；;：:！!？?、]/g, '')          // 标点（全半角各一份）
    .toLowerCase()
    .trim();
}

const legacy = d1('SELECT section, content FROM memory_entries');
const next = d1('SELECT section, content FROM memory_chunks');

const L = new Map();
for (const r of legacy) L.set(norm(r.section) + '|' + norm(r.content), r);
const N = new Map();
for (const r of next) N.set(norm(r.section) + '|' + norm(r.content), r);

const onlyLegacy = [...L.entries()].filter(([k]) => !N.has(k));
const onlyNext = [...N.entries()].filter(([k]) => !L.has(k));

console.log(`legacy ${legacy.length} 条 / next ${next.length} 条`);
console.log(`只在 legacy：${onlyLegacy.length}　只在 next：${onlyNext.length}　两边都有：${L.size - onlyLegacy.length}`);

function show(title, rows) {
  if (rows.length === 0) return;
  const n = ALL ? rows.length : Math.min(20, rows.length);
  console.log(`\n--- ${title}（前 ${n} / 共 ${rows.length}）---`);
  for (const [, r] of rows.slice(0, n)) {
    console.log(`[${r.section}] ${String(r.content).slice(0, 90)}`);
  }
}

show('只在 legacy（可能是 next 丢的）', onlyLegacy);
show('只在 next（可能是新切分）', onlyNext);
