import { describe, expect, it } from 'vitest';
import {
  assertAllowed,
  checkPolicy,
  PolicyError,
  policyTable,
  tierOf,
  type ActionKind,
} from './policy';

const job = { actor: 'job' as const };
const agent = { actor: 'agent' as const, channel: 'mobile' };

describe('policy 档位', () => {
  it('A 档：日常记忆写入', () => {
    for (const kind of ['fact.upsert', 'chunk.upsert', 'event.write', 'memory.write'] as ActionKind[]) {
      expect(tierOf(kind)).toBe('A');
    }
  });

  it('B 档：改自身行为要先隔离验证', () => {
    for (const kind of ['prompt.change', 'extractor.change', 'retrieval.change'] as ActionKind[]) {
      expect(tierOf(kind)).toBe('B');
    }
  });

  it('C 档：原文与删除类永远禁止', () => {
    for (const kind of [
      'message.update',
      'message.delete',
      'memory.delete',
      'fact.delete',
      'event.delete',
      'constitution.write',
      'policy.change',
      'audit.disable',
    ] as ActionKind[]) {
      expect(tierOf(kind)).toBe('C');
    }
  });

  it('每类动作都有档位，不会漏配', () => {
    const table = policyTable();
    expect(table.length).toBeGreaterThan(10);
    expect(table.every((row) => ['A', 'B', 'C'].includes(row.tier))).toBe(true);
  });
});

describe('不变量 1：原文只追加', () => {
  it('改消息被拒绝', () => {
    const v = checkPolicy({ kind: 'message.update' }, job);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('原文只追加');
  });

  it('删消息被拒绝', () => {
    const v = checkPolicy({ kind: 'message.delete' }, job);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('原文只追加');
  });
});

describe('不变量 2：记忆不许物理删除', () => {
  it('删事实被拒绝并提示用 expire', () => {
    const v = checkPolicy({ kind: 'fact.delete' }, job);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('expire');
  });

  it('删记忆文件被拒绝', () => {
    expect(checkPolicy({ kind: 'memory.delete' }, job).ok).toBe(false);
  });
});

describe('不变量 3：宪法不许模型写', () => {
  it('写宪法被拒绝，连 agent 也不行', () => {
    expect(checkPolicy({ kind: 'constitution.write' }, agent).ok).toBe(false);
    expect(checkPolicy({ kind: 'constitution.write' }, job).ok).toBe(false);
  });
});

describe('不变量 4：写入必须带出处', () => {
  it('没有来源消息 id 的事实被拒绝', () => {
    const v = checkPolicy({ kind: 'fact.upsert' }, job);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('来源消息 id');
  });

  it('带 id 通过', () => {
    const v = checkPolicy({ kind: 'fact.upsert', sourceMessageIds: [1301, 1302] }, job);
    expect(v.ok).toBe(true);
    expect(v.tier).toBe('A');
  });

  it('历史迁移允许无出处一次性导入', () => {
    const v = checkPolicy({ kind: 'event.write', legacyOrigin: true }, job);
    expect(v.ok).toBe(true);
  });

  it('纯参数动作不需要出处', () => {
    expect(checkPolicy({ kind: 'param.tune' }, job).ok).toBe(true);
  });
});

describe('不变量 6：自主动作必须留意图与证据', () => {
  it('agent 没写 intent 被拒绝', () => {
    const v = checkPolicy({ kind: 'fact.expire', evidence: ['recall-miss'] }, agent);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('intent');
  });

  it('agent 没写 evidence 被拒绝', () => {
    const v = checkPolicy({ kind: 'fact.expire', intent: '旧事实已过时' }, agent);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('evidence');
  });

  it('agent 写全了通过', () => {
    const v = checkPolicy(
      { kind: 'fact.expire', intent: '新事实覆盖旧事实', evidence: ['msg:1301'] },
      agent,
    );
    expect(v.ok).toBe(true);
  });

  it('定时任务不需要 intent（它不是自主决定）', () => {
    expect(checkPolicy({ kind: 'memory.write' }, job).ok).toBe(true);
  });
});

describe('assertAllowed', () => {
  it('违规抛 PolicyError，并带上动作类型', () => {
    expect(() => assertAllowed({ kind: 'message.delete' }, job)).toThrow(PolicyError);
    try {
      assertAllowed({ kind: 'memory.delete' }, job);
    } catch (e) {
      expect(e).toBeInstanceOf(PolicyError);
      expect((e as PolicyError).kind).toBe('memory.delete');
    }
  });

  it('合规时返回档位', () => {
    expect(assertAllowed({ kind: 'event.write', sourceMessageIds: [7] }, job)).toEqual({ tier: 'A' });
  });
});
