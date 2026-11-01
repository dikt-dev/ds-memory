import { describe, expect, it } from 'vitest';
import { collapseOngoing, sameTopic } from './memory-ongoing';

const DOC = `# 长期记忆

## 进行中的事项

- [26-10-27] [进行中] 桌宠（给AI开电脑权限）：先做小权限
- [26-10-28] [搁置] 回滚方案草稿：用户多次拖延，助手催了多轮仍未动笔
- [26-10-29] [搁置] 回滚方案草稿:用户仍拖延未写,助手反复催,用户嫌总提草稿
- [26-10-30] 回滚方案草稿写完了，待 11-01 解冻实施
- [26-11-01] [已完成] 回滚方案落地了，用户跑过一遍没问题
- [26-10-31] 用户要回上海（预计下月 20 号）：要交代住处/网络/电源

## 雷区与禁忌

- [26-10-28] 回滚方案草稿别催了
`;

describe('同主题判定', () => {
  it('回滚几条算同一件事', () => {
    expect(sameTopic('- [26-10-28] [搁置] 回滚方案草稿：用户多次拖延', '- [26-10-30] 回滚方案草稿写完了')).toBe(true);
  });

  it('泛词不算（用户/助手）', () => {
    expect(sameTopic('- [26-10-27] 用户问桌宠权限', '- [26-10-28] 助手说回滚的事')).toBe(false);
  });
});

describe('合并过期状态行', () => {
  it('同一件事只留最新一条，[已完成] 留着', () => {
    const { text, removed } = collapseOngoing(DOC);
    expect(removed.length).toBeGreaterThanOrEqual(2);
    expect(text).toContain('[26-11-01] [已完成] 回滚方案落地了');
    expect(text).not.toContain('用户多次拖延');
    expect(text).not.toContain('用户仍拖延未写');
  });

  it('不碰别的分区', () => {
    const { text } = collapseOngoing(DOC);
    expect(text).toContain('## 雷区与禁忌');
    expect(text).toContain('回滚方案草稿别催了');
  });

  it('括号里是主题的一部分（桌宠（给AI开电脑权限））', () => {
    expect(sameTopic('- [26-10-15] [搁置] 桌宠（给AI开电脑权限）：一直没动', '- [26-10-27] [进行中] 桌宠（给AI开电脑权限）：先做小权限')).toBe(true);
  });

  it('不相干的事项原样保留', () => {
    const { text } = collapseOngoing(DOC);
    expect(text).toContain('桌宠（给AI开电脑权限）');
    expect(text).toContain('用户要回上海');
  });

  it('没有重复时完全不改（幂等）', () => {
    const once = collapseOngoing(DOC).text;
    const twice = collapseOngoing(once);
    expect(twice.text).toBe(once);
    expect(twice.removed).toEqual([]);
  });
});
