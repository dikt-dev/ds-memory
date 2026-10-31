import { describe, expect, it } from 'vitest';
import { applySubjectFixes, entryBody, planSubjectFixes } from './subject-fix';

const doc = [
  '## 关于用户',
  '- 职业=嵌入式开发',
  '## 进行中的事项',
  '- [进行中] 记忆管理优化：已落地第一阶段，下一步待做分层预算',
  '- 回滚方案草稿写完（memory-rollback-plan.md：每日快照+恢复接口、不做版本历史）；不再搁置，待 11-01 解冻实施',
  '- [进行中] 用户已经在写迁移方案',
  '## 共同经历',
  '- [26-10-30] 半夜写了监控脚本',
  '- [26-10-30] 一起看完了可塑性记忆',
].join('\n');

describe('entryBody', () => {
  it('去掉日期前缀', () => {
    expect(entryBody('- [26-10-30] 半夜写了监控脚本')).toBe('半夜写了监控脚本');
  });
  it('没有前缀时原样返回', () => {
    expect(entryBody('- 职业=嵌入式开发')).toBe('职业=嵌入式开发');
  });
});

describe('planSubjectFixes', () => {
  it('动作条目补「用户」，状态标签保留在前面', () => {
    const fixes = planSubjectFixes(doc);
    const first = fixes.find((f) => f.from.startsWith('[进行中] 记忆管理优化'));
    expect(first?.to).toBe('[进行中] 用户记忆管理优化：已落地第一阶段，下一步待做分层预算');
  });

  it('人工规则优先于通用规则', () => {
    const fixes = planSubjectFixes(doc);
    const rollback = fixes.find((f) => f.from.startsWith('回滚方案草稿写完'));
    expect(rollback?.to).toContain('用户写完了回滚方案草稿');
    expect(rollback?.reason).toContain('用户写的');
  });

  it('已有主体的条目不重复加', () => {
    const fixes = planSubjectFixes(doc);
    expect(fixes.some((f) => f.from.includes('用户已经在写迁移方案'))).toBe(false);
  });

  it('键=值 静态事实不动', () => {
    expect(planSubjectFixes(doc).some((f) => f.from.includes('职业='))).toBe(false);
  });

  it('一起/我们 不当作缺主体', () => {
    expect(planSubjectFixes(doc).some((f) => f.from.includes('一起看完了'))).toBe(false);
  });
});

describe('applySubjectFixes', () => {
  it('只改命中的行，其它原样保留', () => {
    const { text, changes } = applySubjectFixes(doc);
    expect(changes.length).toBeGreaterThan(0);
    expect(text).toContain('## 关于用户');
    expect(text).toContain('- 职业=嵌入式开发');
    expect(text).toContain('- [26-10-30] 一起看完了可塑性记忆');
    expect(text).toContain('- [进行中] 用户记忆管理优化');
    expect(text).toContain('用户写完了回滚方案草稿');
    // 幂等：再跑一次没有新改动
    expect(applySubjectFixes(text).changes).toEqual([]);
  });

  it('没有需要修的时候原样返回', () => {
    const clean = '## 关于用户\n- 职业=嵌入式开发';
    expect(applySubjectFixes(clean).changes).toEqual([]);
    expect(applySubjectFixes(clean).text).toBe(clean);
  });
});
