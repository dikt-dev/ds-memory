import { describe, expect, it } from 'vitest';
import { renderFactsDoc, type FactDocRow } from './memory-doc';

function fact(over: Partial<FactDocRow> = {}): FactDocRow {
  return {
    section: '关于他',
    content: '职业=嵌入式开发',
    confidence: 0.85,
    valid_from: '2026-10-01',
    valid_to: null,
    subject: '职业',
    predicate: '是',
    ...over,
  };
}

describe('renderFactsDoc', () => {
  it('按分区输出标题', () => {
    const md = renderFactsDoc([fact(), fact({ section: '共同经历', content: '一起走回滚流程' })]);
    expect(md).toContain('## 关于他');
    expect(md).toContain('## 共同经历');
  });

  it('分区按固定顺序排（人物底色在最前）', () => {
    const md = renderFactsDoc([fact({ section: '共同经历' }), fact({ section: '人物底色' })]);
    expect(md.indexOf('## 人物底色')).toBeLessThan(md.indexOf('## 共同经历'));
  });

  it('标注可信度与生效时间', () => {
    const md = renderFactsDoc([fact()]);
    expect(md).toContain('确定');
    expect(md).toContain('自 2026-10-01');
  });

  it('失效事实单列，不混在有效区', () => {
    const md = renderFactsDoc([fact(), fact({ content: '城市=北京', valid_to: '2026-10-31' })]);
    const expiredPart = md.slice(md.indexOf('## 已失效'));
    expect(expiredPart).toContain('城市=北京');
    expect(md.slice(0, md.indexOf('## 已失效'))).not.toContain('城市=北京');
  });

  it('空库也能渲染，不崩', () => {
    const md = renderFactsDoc([]);
    expect(md).toContain('# 她记得的事');
    expect(md).toContain('共 0 条有效');
  });

  it('低可信度标注为存疑', () => {
    const md = renderFactsDoc([fact({ confidence: 0.3 })]);
    expect(md).toContain('存疑');
  });
});
