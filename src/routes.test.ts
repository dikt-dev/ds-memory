import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { routesForTest as app } from './index';

/**
 * 路由清单快照：拆分 index.ts 时，路径和方法必须一个不差。
 *
 * 拆文件唯一看不出来的风险是「漏挂一个路由」——编译器不管，测试也不覆盖冷门端点。
 * 这份快照就是给那次拆分兜底的：改错了这里直接红。
 * 首次运行会把当前清单写成快照（bootstrap）。
 */
const SNAPSHOT = join(process.cwd(), 'src', 'routes.snapshot.json');

describe('路由清单', () => {
  it('与快照完全一致（新增路由请同步更新 routes.snapshot.json）', () => {
    // Hono 对 app.post(path, requireAuth, handler) 会按 handler 数量各记一条 routes，
    // 所以这里按 (method, path) 去重后比较：这份快照的用途是「别漏挂路由」，
    // 不是「别改 handler 个数」（2026-11-08：一条路由多挂一个 handler 就让快照红，纯噪声）。
    const dedupe = (rows: Array<[string, string]>) => {
      const seen = new Set<string>();
      const out: Array<[string, string]> = [];
      for (const row of rows) {
        const key = row[0] + ' ' + row[1];
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(row);
      }
      return out.sort((a, b) => (a[0] + a[1]).localeCompare(b[0] + b[1]));
    };
    const actual = dedupe(app.routes.map((r) => [r.method, r.path] as [string, string]));
    if (!existsSync(SNAPSHOT)) {
      writeFileSync(SNAPSHOT, JSON.stringify(actual, null, 2) + '\n', 'utf8');
      return;
    }
    const snapshot = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as Array<[string, string]>;
    expect(actual).toEqual(snapshot);
  });
});
