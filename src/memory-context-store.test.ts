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
