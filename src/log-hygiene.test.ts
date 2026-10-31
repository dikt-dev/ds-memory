import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** 日志出口白名单：console.log 只允许出现在 trace.ts（它就是封装本身）。 */
const ALLOWED = 'trace.ts';

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('日志出口', () => {
  it('业务代码里不允许裸 console.log', () => {
    const root = join(process.cwd(), 'src');
    const offenders = walk(root)
      .filter((file) => !file.endsWith('.test.ts') && !file.endsWith(ALLOWED))
      .filter((file) => /console\.log\(/.test(readFileSync(file, 'utf8')))
      .map((file) => file.slice(root.length));
    expect(offenders).toEqual([]);
  });
});
