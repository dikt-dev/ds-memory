import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cronBranch } from './index';

/**
 * 定时任务分派：每个触发器（wrangler 里配的表达式）都必须落到一个分支上。
 * 少写一条 if，那个 cron 就静默不跑——只在日志里留一行 unknown，没人看得见。
 */
const CONFIGURED = ['0 20 * * *', '5 20 * * *', '* 1-14 * * *', '* 23,0,14,15,16 * * *'];

describe('cron 分派', () => {
  it('配置里的每个表达式都有分支', () => {
    for (const cron of CONFIGURED) {
      expect(cronBranch(cron), '未分派的 cron: ' + cron).not.toBeNull();
    }
  });

  it('未知表达式返回 null（走 warn 日志，不静默成功）', () => {
    expect(cronBranch('* * * * *')).toBeNull();
    expect(cronBranch('')).toBeNull();
  });

  it('与 wrangler 配置里的 crons 保持一致', () => {
    const toml = join(process.cwd(), 'wrangler.toml');
    const local = join(process.cwd(), 'wrangler.local.toml');
    const file = existsSync(toml) ? toml : existsSync(local) ? local : null;
    if (!file) return; // 有的环境没有配置文件，跳过
    const text = readFileSync(file, 'utf8');
    const crons = [...text.matchAll(/crons\s*=\s*\[([^\]]*)\]/g)]
      .flatMap((m) => [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]));
    for (const cron of crons) {
      expect(cronBranch(cron), '配置文件里有、代码里没分派: ' + cron).not.toBeNull();
    }
  });
});
