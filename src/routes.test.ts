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
    const actual = app.routes
      .map((r) => [r.method, r.path] as [string, string])
      .sort((a, b) => (a[0] + a[1]).localeCompare(b[0] + b[1]));
    if (!existsSync(SNAPSHOT)) {
      writeFileSync(SNAPSHOT, JSON.stringify(actual, null, 2) + '\n', 'utf8');
      return;
    }
    const snapshot = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as Array<[string, string]>;
    expect(actual).toEqual(snapshot);
  });
});
