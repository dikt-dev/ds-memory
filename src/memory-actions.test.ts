import { describe, expect, it } from 'vitest';
import { normalizeAction, toActionRecord } from './memory-actions';

const base = {
  actor: 'agent' as const,
  intent: '同一 predicate 出现新事实，旧事实过期',
  evidence: ['msg:1301', 'msg:1302'],
  diff: 'fact.old-address valid_to=2026-10-31',
  before: 'valid_to=null',
  after: 'valid_to=2026-10-31',
  revertible: true,
};

describe('normalizeAction', () => {
  it('档位由 policy 决定，调用方不能自己标 A 档', () => {
    const a = normalizeAction({ ...base, kind: 'prompt.change' });
    expect(a.tier).toBe('B');
  });

  it('C 档动作直接拒绝入库', () => {
    expect(() => normalizeAction({ ...base, kind: 'message.delete' })).toThrow(/forbidden/);
    expect(() => normalizeAction({ ...base, kind: 'constitution.write' })).toThrow(/forbidden/);
  });

  it('缺 kind 报错', () => {
    expect(() => normalizeAction({ ...base, kind: '' as never })).toThrow(/kind/);
  });

  it('默认 result=ok，带时间戳', () => {
    const a = normalizeAction({ ...base, kind: 'fact.expire' }, 1700000000000);
    expect(a.result).toBe('ok');
    expect(a.created_at).toBe(1700000000000);
  });

  it('超长文本被截断，不把整段记忆塞进审计表', () => {
    const a = normalizeAction({ ...base, kind: 'fact.expire', diff: 'x'.repeat(9000) });
    expect(a.diff.length).toBeLessThanOrEqual(4001);
  });

  it('证据最多留 20 条', () => {
    const many = Array.from({ length: 40 }, (_, i) => 'msg:' + i);
    const a = normalizeAction({ ...base, kind: 'fact.expire', evidence: many });
    expect(a.evidence.length).toBe(20);
  });
});

describe('toActionRecord', () => {
  it('把行还原成记录，并容忍坏 JSON', () => {
    const a = toActionRecord({
      id: 7,
      actor: 'agent',
      tier: 'A',
      kind: 'fact.expire',
      intent: 'i',
      evidence: 'not-json',
      diff: 'd',
      before_v: 'b',
      after_v: 'a',
      result: 'ok',
      revertible: 1,
      reverted_by: null,
      created_at: 1,
    });
    expect(a.evidence).toEqual([]);
    expect(a.revertible).toBe(true);
    expect(a.id).toBe(7);
  });

  it('正常 JSON 证据能读回', () => {
    const a = toActionRecord({
      id: 8,
      actor: 'job',
      tier: 'A',
      kind: 'event.write',
      intent: '',
      evidence: '["msg:1","msg:2"]',
      diff: '',
      before_v: '',
      after_v: '',
      result: 'ok',
      revertible: 0,
      reverted_by: null,
      created_at: 2,
    });
    expect(a.evidence).toEqual(['msg:1', 'msg:2']);
    expect(a.revertible).toBe(false);
  });
});
