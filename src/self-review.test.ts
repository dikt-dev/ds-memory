import { describe, expect, it } from 'vitest';
import { SELF_REVIEW_ALLOWED, vetProposals, type Proposal } from './self-review';
import { tierOf } from './policy';

const good = (over: Partial<Proposal> = {}): Proposal => ({
  kind: 'chunk.tune',
  target: 'chunk_1',
  intent: '这条片段从没被召回，降重要度让位',
  evidence: ['recall-misses:3'],
  value: '1',
  ...over,
});

describe('自审动作白名单', () => {
  it('只包含 A 档动作', () => {
    for (const kind of SELF_REVIEW_ALLOWED) expect(tierOf(kind)).toBe('A');
  });

  it('不含改提示词、改规则、删记忆', () => {
    expect(SELF_REVIEW_ALLOWED).not.toContain('prompt.change');
    expect(SELF_REVIEW_ALLOWED).not.toContain('memory.delete');
    expect(SELF_REVIEW_ALLOWED).not.toContain('constitution.write');
  });
});

describe('vetProposals', () => {
  it('合规提案通过', () => {
    const { accepted, rejected } = vetProposals([good()]);
    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(0);
  });

  it('B 档动作被拒（改提示词）', () => {
    const { accepted, rejected } = vetProposals([good({ kind: 'prompt.change' })]);
    expect(accepted).toHaveLength(0);
    expect(rejected[0].reason).toContain('白名单');
  });

  it('C 档动作被拒（删记忆）', () => {
    const { rejected } = vetProposals([good({ kind: 'memory.delete' })]);
    expect(rejected[0].reason).toContain('白名单');
  });

  it('缺 intent 被拒', () => {
    const { rejected } = vetProposals([good({ intent: '' })]);
    expect(rejected[0].reason).toContain('intent');
  });

  it('缺 evidence 被拒', () => {
    const { rejected } = vetProposals([good({ evidence: [] })]);
    expect(rejected[0].reason).toContain('evidence');
  });

  it('缺 target 被拒', () => {
    const { rejected } = vetProposals([good({ target: '' })]);
    expect(rejected[0].reason).toContain('target');
  });

  it('最多只接受 5 条', () => {
    const many = Array.from({ length: 8 }, (_, i) => good({ target: 'c' + i }));
    const { accepted, rejected } = vetProposals(many);
    expect(accepted).toHaveLength(5);
    expect(rejected.length).toBe(3);
    expect(rejected[0].reason).toContain('上限');
  });

  it('超过 8 条的输入直接截断', () => {
    const many = Array.from({ length: 12 }, (_, i) => good({ target: 'c' + i }));
    const { accepted, rejected } = vetProposals(many);
    expect(accepted.length + rejected.length).toBe(8);
  });

  it('空数组 = 什么都不做（合法结果）', () => {
    const { accepted, rejected } = vetProposals([]);
    expect(accepted).toEqual([]);
    expect(rejected).toEqual([]);
  });

  it('非字符串字段被规整，不会抛异常', () => {
    const messy = [{ kind: 'chunk.tune', target: 123, intent: null, evidence: 'x', value: 2 }] as never;
    expect(() => vetProposals(messy)).not.toThrow();
    const { accepted } = vetProposals(messy);
    expect(accepted).toHaveLength(0);
  });
});
