import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** 日志出口白名单：console.log 只允许出现在 trace.ts 里（它就是封装本身）。 */
const ALLOWED = new Set(['trace.ts']);

const SRC = fileURLToPath(new URL('.', import.meta.url));

function scan(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      scan(full, out);
      continue;
    }
    if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue;
    out.push(full);
  }
  return out;
}

describe('日志出口', () => {
  it('业务代码里不允许裸 console.log', () => {
    const offenders = scan(SRC)
      .filter((file) => !ALLOWED.has(file.split(/[\\/]/).pop() ?? ''))
      .filter((file) => /console\.log\(/.test(readFileSync(file, 'utf8')))
      .map((file) => file.slice(SRC.length).replace(/\\/g, '/'));
    expect(offenders).toEqual([]);
  });
});
