import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 代码卫生：fire-and-forget 的 promise 必须挂 .catch。
 *
 * `void foo()` 只是把返回值扔掉，并不是处理错误——promise 拒绝时会变成
 * unhandledRejection，Worker 里表现为「请求莫名其妙 500 / 日志里什么都没有」。
 * 这条测试把口子焊死：以后谁再写裸 void 调用会直接红。
 */
function collect(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) collect(p, out);
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

describe('代码卫生', () => {
  it('没有未挂 catch 的 void promise', () => {
    const offenders: string[] = [];
    for (const file of collect(join(process.cwd(), 'src'))) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (/\bvoid [a-zA-Z_$][\w$.]*\(/.test(line) && !line.includes('.catch(')) {
            offenders.push(file.split('src').pop() + ':' + (i + 1) + ' ' + line.trim().slice(0, 80));
          }
        });
    }
    expect(offenders).toEqual([]);
  });
});
