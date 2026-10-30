#!/usr/bin/env node
/**
 * memory-check.mjs — 记忆体检（只读，不写任何数据）
 *
 * 借鉴 dsh-fish 的「记忆体检」思路：它在设置页给出「哪两句对不上、哪些快忘了、
 * 哪些快固定下来了」，但只读账本、不算分、不写盘。我们这里做同一件事的脚本版。
 *
 * 用法：
 *   node scripts/memory-check.mjs
 *   node scripts/memory-check.mjs --config wrangler.local.toml
 *   node scripts/memory-check.mjs --json
 *
 * 检查项：
 *   1. 规模：entries/chunks 行数与内容总字节，估算 KV 索引体积（20MB 悬崖）
 *   2. 向量：memory_chunks 里 vec IS NULL 的条数（应恒为 0，否则语义召回退化）
 *   3. 幽灵行：conversation origin 里超过 30 天的行（没有 TTL 就会只增不减）
 *   4. 重复：同一 content 出现在多个 origin
 *   5. 弱记忆：importance <= 2 且日期早于 30 天的条目（快忘了的那批）
 *
 * 退出码：0 无硬失败；1 有硬失败（向量缺失 / 幽灵行）。
 */
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WRANGLER = join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const DB = 'ds-memory-db';

const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const CONFIG = opt('config', 'wrangler.local.toml');
const AS_JSON = argv.includes('--json');

const KV_INDEX_MAX_BYTES = 20 * 1024 * 1024;

function d1(sql) {
  const out = execFileSync(
    process.execPath,
    [WRANGLER, 'd1', 'execute', DB, '--remote', '--config', CONFIG, '--json', '--command', sql],
    { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 },
  );
  const start = out.indexOf('[');
  const parsed = JSON.parse(out.slice(start));
  return parsed?.[0]?.results ?? [];
}

function columnsOf(table) {
  try {
    // 用 pragma_table_info 的函数形式：PRAGMA 语句在 wrangler 的 JSON 输出里不稳定
    return new Set(d1(`SELECT name FROM pragma_table_info('${table}')`).map((r) => String(r.name)));
  } catch {
    return new Set();
  }
}

function count(sql, fallback = 0) {
  try {
    const rows = d1(sql);
    return Number(rows?.[0]?.c ?? fallback);
  } catch {
    return fallback;
  }
}

const now = Date.now();
const DAY = 86_400_000;
const cutoff = new Date(now - 30 * DAY).toISOString().slice(0, 10);

const report = { checkedAt: new Date(now + 8 * 3600_000).toISOString().replace('Z', '+08:00'), sections: [] };
const hardFails = [];

// ── 1. 规模 ────────────────────────────────────────────────
{
  const entries = count('SELECT COUNT(*) AS c FROM memory_entries');
  const chunks = count('SELECT COUNT(*) AS c FROM memory_chunks');
  const contentBytes = count('SELECT COALESCE(SUM(LENGTH(content)), 0) AS c FROM memory_entries');
  // 粗略估算 KV 里那份 {v,at,rows} 的大小：内容 + 每行约 220 字节的固定开销
  const estIndexBytes = contentBytes + entries * 220;
  const ratio = estIndexBytes / KV_INDEX_MAX_BYTES;
  report.sections.push({
    name: '规模',
    rows: [
      `memory_entries = ${entries}`,
      `memory_chunks  = ${chunks}`,
      `内容总字节     = ${(contentBytes / 1024).toFixed(1)} KB`,
      `KV 索引估算    = ${(estIndexBytes / 1024).toFixed(1)} KB（上限 ${(KV_INDEX_MAX_BYTES / 1024 / 1024).toFixed(0)} MB，用了 ${(ratio * 100).toFixed(2)}%）`,
    ],
    warn: ratio > 0.5 ? '索引接近 KV 上限：超过 20MB 会把所有向量置空（P1-4）' : null,
  });
}

// ── 2. 向量覆盖 ────────────────────────────────────────────
{
  const missing = count('SELECT COUNT(*) AS c FROM memory_chunks WHERE vec IS NULL');
  const total = count('SELECT COUNT(*) AS c FROM memory_chunks');
  report.sections.push({
    name: '向量',
    rows: [`缺向量 = ${missing} / ${total}`],
    warn: missing > 0 ? '有 chunk 没有向量，语义召回会退回纯关键词' : null,
  });
  if (missing > 0) hardFails.push(`${missing} 条 chunk 缺向量`);
}

// ── 3. 幽灵行（无 TTL 的 conversation origin）──────────────
{
  const cols = columnsOf('memory_facts');
  if (cols.has('origin') && cols.has('valid_from')) {
    const stale = count(
      `SELECT COUNT(*) AS c FROM memory_facts WHERE origin = 'conversation' AND valid_from IS NOT NULL AND valid_from < '${cutoff}'`,
    );
    const byOrigin = d1('SELECT origin, COUNT(*) AS c FROM memory_facts GROUP BY origin ORDER BY c DESC');
    report.sections.push({
      name: '来源分布 / 幽灵行',
      rows: [
        ...byOrigin.map((r) => `memory_facts[${r.origin}] = ${r.c}`),
        `conversation 且早于 ${cutoff} = ${stale}` + (stale > 0 ? '（没有 TTL 的会话事实，只增不减）' : ''),
      ],
      warn: stale > 0 ? '会话事实从不清理，会持续挤占召回（P1-6）' : null,
    });
    if (stale > 0) hardFails.push(`${stale} 条过期 conversation 事实`);
  } else {
    report.sections.push({ name: '来源分布 / 幽灵行', rows: ['表结构不含 origin/valid_from，跳过'], warn: null });
  }
}

// ── 4. 重复内容（跨 origin 同一句话）──────────────────────
{
  const cols = columnsOf('memory_facts');
  if (cols.has('content') && cols.has('origin')) {
    const dup = d1(
      `SELECT content, COUNT(DISTINCT origin) AS o, COUNT(*) AS c FROM memory_facts
       GROUP BY content HAVING COUNT(*) > 1 ORDER BY c DESC LIMIT 5`,
    );
    report.sections.push({
      name: '重复',
      rows: dup.length
        ? dup.map((r) => `×${r.c}（${r.o} 个来源）${String(r.content).slice(0, 40)}`)
        : ['没有重复内容'],
      warn: dup.length ? '同一句话存了多份，召回声明显偏高' : null,
    });
  }
}

// ── 5. 弱记忆 ─────────────────────────────────────────────
{
  const cols = columnsOf('memory_entries');
  if (cols.has('importance') && cols.has('date')) {
    const weak = d1(
      `SELECT section, substr(content, 1, 36) AS c, date, importance FROM memory_entries
       WHERE importance <= 2 AND date IS NOT NULL AND date < '${cutoff}'
       ORDER BY date ASC LIMIT 8`,
    );
    const totalWeak = count(
      `SELECT COUNT(*) AS c FROM memory_entries WHERE importance <= 2 AND date IS NOT NULL AND date < '${cutoff}'`,
    );
    report.sections.push({
      name: '弱记忆（快忘了）',
      rows: [`共 ${totalWeak} 条`, ...weak.map((r) => `${r.date} [${r.section}] ${r.c}`)],
      warn: null,
    });
  }
}

if (AS_JSON) {
  console.log(JSON.stringify({ ...report, hardFails }, null, 2));
} else {
  console.log(`\n记忆体检 · ${report.checkedAt}\n`);
  for (const s of report.sections) {
    console.log(`── ${s.name}`);
    for (const r of s.rows) console.log(`   ${r}`);
    if (s.warn) console.log(`   ⚠ ${s.warn}`);
    console.log('');
  }
}

process.exit(hardFails.length ? 1 : 0);
