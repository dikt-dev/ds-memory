#!/usr/bin/env node
/**
 * archive-check.mjs — 每日归档体检（只读，不写任何数据）
 *
 * 用法：
 *   node scripts/archive-check.mjs                 # 检查「昨天」（北京时间）
 *   node scripts/archive-check.mjs --date 2026-10-28
 *   node scripts/archive-check.mjs --config wrangler.local.toml
 *
 * 检查项：
 *   1. cron_runs 有当天 daily_archive 且 status=done
 *   2. detail 里没有「提炼错误」；解析出「归档 N 条消息」
 *   3. D1 该日剩余消息数与 N 对账（已清理则为 0，需在 R2 有日文件）
 *   4. R2 chat_logs/<date>.log 存在且非空
 *   5. memory_chunks no_vec = 0
 *   6. memory_facts/events/entries/chunks/links 计数
 *
 * 退出码：0 全部通过；1 有失败项。
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WRANGLER = join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const DB = 'ds-memory-db';
const BUCKET = 'ds-memory-r2';

const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const CONFIG = opt('config', 'wrangler.local.toml');

/** 北京时间「昨天」 */
function yesterdayInBeijing() {
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  now.setUTCDate(now.getUTCDate() - 1);
  return now.toISOString().slice(0, 10);
}
const DATE = opt('date', yesterdayInBeijing());

function run(cmd, args) {
  return execFileSync(cmd, args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024,
  });
}

function d1(sql) {
  const out = run(process.execPath, [
    WRANGLER, 'd1', 'execute', DB, '--remote', '--config', CONFIG, '--json', '--command', sql,
  ]);
  const parsed = JSON.parse(out);
  return parsed?.[0]?.results ?? [];
}

function r2Head(key, tmpDir) {
  const file = join(tmpDir, key.replace(/[\\/]/g, '_'));
  try {
    run(process.execPath, [
      WRANGLER, 'r2', 'object', 'get', `${BUCKET}/${key}`, '--file', file, '--remote', '--config', CONFIG,
    ]);
    return { exists: true, bytes: statSync(file).size };
  } catch (e) {
    return { exists: false, bytes: 0, error: String(e?.stderr ?? e).slice(0, 200) };
  }
}

const checks = [];
const add = (name, ok, detail, level = ok ? 'ok' : 'fail') => {
  checks.push({ name, ok, detail, level });
};

const tmpDir = mkdtempSync(join(tmpdir(), 'archive-check-'));
let exitCode = 0;
try {
  // 1) cron_runs
  const cron = d1(
    `SELECT status, detail, run_at FROM cron_runs WHERE job_type = 'daily_archive' AND target = '${DATE}' ORDER BY id DESC LIMIT 1`,
  )[0];
  if (!cron) {
    add('cron_runs', false, `没有 ${DATE} 的 daily_archive 记录（可能还没跑，或用 --date 指定日期）`);
  } else {
    add('cron 状态', cron.status === 'done', `status=${cron.status} run_at=${cron.run_at}`);
    const detail = String(cron.detail ?? '');
    add('提炼', !detail.includes('提炼错误'), detail.includes('提炼错误') ? 'detail 含「提炼错误」，需要补跑' : '无「提炼错误」');
    const m = detail.match(/归档\s*(\d+)\s*条消息/);
    add('归档条数', Boolean(m), m ? `detail 记录 ${m[1]} 条` : `detail 未报告条数: ${detail.slice(0, 80)}`);
    var archivedCount = m ? Number(m[1]) : null;
    var detailText = detail;
  }

  // 2) D1 对账
  const d1n = d1(`SELECT COUNT(*) n FROM messages WHERE date_key = '${DATE}'`)[0]?.n ?? 0;
  if (d1n === 0) {
    add('D1 对账', true, 'D1 该日已清理（符合"归档+提炼都成功才删"的设计）', 'warn');
  } else if (archivedCount != null) {
    add('D1 对账', d1n === archivedCount, `D1 ${d1n} 条 vs detail ${archivedCount} 条`);
  } else {
    add('D1 对账', true, `D1 ${d1n} 条（无 detail 基线可比）`, 'warn');
  }

  // 3) R2 日文件
  const r2 = r2Head(`chat_logs/${DATE}.log`, tmpDir);
  add('R2 日文件', r2.exists && r2.bytes > 0, r2.exists
    ? `chat_logs/${DATE}.log ${(r2.bytes / 1024).toFixed(1)} KB`
    : `缺少 chat_logs/${DATE}.log`);

  // 4) 向量完整性
  const vec = d1('SELECT COUNT(*) chunks, SUM(CASE WHEN vec IS NULL THEN 1 ELSE 0 END) no_vec FROM memory_chunks')[0] ?? {};
  add('no_vec', (vec.no_vec ?? 0) === 0, `chunks=${vec.chunks ?? 0} no_vec=${vec.no_vec ?? 0}`);

  // 5) 记忆规模
  const c = d1(`SELECT
      (SELECT COUNT(*) FROM memory_facts) facts,
      (SELECT COUNT(*) FROM memory_events) events,
      (SELECT COUNT(*) FROM memory_entries) entries,
      (SELECT COUNT(*) FROM memory_chunks) chunks,
      (SELECT COUNT(*) FROM memory_links) links,
      (SELECT COUNT(*) FROM memory_audit) audit`)[0] ?? {};
  add('记忆规模', true, `facts=${c.facts} events=${c.events} entries=${c.entries} chunks=${c.chunks} links=${c.links} audit=${c.audit}`);
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}

const icon = (c) => (c.level === 'warn' ? '⚠️' : c.ok ? '✅' : '❌');
console.log(`\n归档体检  ${DATE}  配置=${CONFIG}\n` + '─'.repeat(64));
for (const c of checks) {
  console.log(`${icon(c)}  ${c.name.padEnd(10, '　')} ${c.detail}`);
  if (!c.ok) exitCode = 1;
}
console.log('─'.repeat(64));
console.log(exitCode === 0 ? '结论：通过，可以继续观察\n' : '结论：有失败项，先看上面 ❌ 再决定是否补跑\n');
process.exit(exitCode);
