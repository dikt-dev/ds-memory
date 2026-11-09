import { describe, expect, it } from 'vitest';
import { provenanceSearchTerm } from './memory-context-store';

describe('provenanceSearchTerm', () => {
  it('优先用 object 做回溯词', () => {
    expect(provenanceSearchTerm({ content: '城市=杭州', object: '杭州' })).toBe('杭州');
  });

  it('没有 object 时去掉状态前缀和 key=', () => {
    expect(provenanceSearchTerm({ content: '[进行中] 项目=星海', object: null })).toBe('星海');
    expect(provenanceSearchTerm({ content: '猫=团子（橘猫）', object: null })).toBe('团子（橘猫）');
  });

  it('去除 LIKE 通配符并限制长度', () => {
    const term = provenanceSearchTerm({ content: 'x'.repeat(80), object: '50%_done' });
    expect(term).toBe('50done');
    expect(term.length).toBeLessThanOrEqual(30);
  });
});

describe('refreshChunksCache：档案条目要能被合并进来', () => {
  it('查档案用的是 origin 列（不是 source）', async () => {
    const { refreshChunksCache } = await import('./memory-context-store');
    const sqls: string[] = [];
    const env = {
      KV: {
        get: async () => null,
        put: async () => undefined,
        delete: async () => undefined,
      },
      DB: {
        prepare: function (sql: string) {
          sqls.push(String(sql));
          return {
            bind: function () {
              return {
                run: async function () { return { meta: { changes: 0 } }; },
                first: async function () { return null; },
                all: async function () { return { results: [] }; },
              };
            },
            run: async function () { return { meta: { changes: 0 } }; },
            first: async function () { return null; },
            all: async function () { return { results: [] }; },
          };
        },
      },
    };
    await refreshChunksCache(env as never, '## 共同经历\n- [26-11-08] 测试条目');
    const archiveSql = sqls.find(function (s) { return s.indexOf('memory_chunks') >= 0; });
    expect(archiveSql).toBeTruthy();
    // 2026-11-09：写成 source='archive' 时永远 0 条，档案条目进不了召回池
    expect(archiveSql).toContain("origin = 'archive'");
    expect(archiveSql).not.toContain("source = 'archive'");
  });
});
