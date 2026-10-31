import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * 守卫测试（ADR-001 S1）：
 * 改写记忆的路径必须过 policy 闸口，否则"边界"就只是一段文档。
 *
 * 允许直接碰这些表/文件的模块只有白名单里的几个——它们内部都调用了
 * assertAllowed 或 insertFacts/writeEvent（那两个函数本身已过闸口）。
 * 新增写入模块时，要么走这两个出口，要么显式加进白名单并说明理由。
 */
// 用 cwd + 相对路径定位源码（vitest 从仓库根跑）；避免 import.meta.url 的类型噪音。
const SRC = process.cwd().replace(/\\/g, '/') + '/src/';

const WRITE_PATTERNS: Array<{ name: string; re: RegExp; allowed: string[] }> = [
  {
    name: 'memory_facts 写入',
    re: /INSERT (OR REPLACE )?INTO memory_facts/,
    allowed: ['memory-context-store.ts'],
  },
  {
    name: 'memory_event_log 写入',
    re: /INSERT INTO memory_event_log/,
    allowed: ['memory-events.ts'],
  },
  {
    name: 'memory.md 落盘',
    re: /putObject\(env, MEMORY_R2_KEY/,
    allowed: ['memory.ts'],
  },
];

const GATED = ['memory.ts', 'memory-events.ts', 'memory-context-store.ts'];

function sources(): Array<{ file: string; text: string }> {
  return readdirSync(SRC)
    .filter((f) => f.endsWith('.ts') && !f.includes('.test.'))
    .map((f) => ({ file: f, text: readFileSync(SRC + f, 'utf8') }));
}

describe('记忆写入必须过 policy 闸口', () => {
  for (const pattern of WRITE_PATTERNS) {
    it(pattern.name + ' 只出现在白名单模块', () => {
      const offenders = sources()
        .filter((s) => pattern.re.test(s.text) && !pattern.allowed.includes(s.file))
        .map((s) => s.file);
      expect(offenders).toEqual([]);
    });
  }

  it('三个写入模块都调用了 assertAllowed', () => {
    const all = sources();
    for (const file of GATED) {
      const src = all.find((s) => s.file === file);
      expect(src, file + ' 应该存在').toBeTruthy();
      expect(src!.text).toContain('assertAllowed');
    }
  });

  it('旧事实不物理删除，只写 valid_to（不变量 2）', () => {
    const store = sources().find((s) => s.file === 'memory-context-store.ts');
    expect(store).toBeTruthy();
    // 事实必须走 expireFactRows；删表只允许发生在派生层（chunk）和老事件表。
    expect(/deleteIds\(env, 'memory_facts'/.test(store!.text)).toBe(false);
    expect(store!.text).toContain('expireFactRows');
  });

  it('policy.ts 自己不写记忆（闸口不该有副作用）', () => {
    const policy = sources().find((s) => s.file === 'policy.ts');
    expect(policy).toBeTruthy();
    expect(/INSERT INTO|UPDATE memory_/.test(policy!.text)).toBe(false);
  });
});
