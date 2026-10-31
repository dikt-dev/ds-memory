import { describe, expect, it } from 'vitest';
import type { Env } from './types';
import {
  detectRuleKeepsakes,
  extractNameFromMemory,
  insertKeepsake,
  loadKeepsakes,
  parseKeepsakeJson,
  renderKeepsakesBlock,
  titleKey,
  titleSimilarity,
  validateKeepsake,
  type Keepsake,
} from './keepsakes';

const T0 = Date.UTC(2026, 9, 30, 4, 0, 0);

/** 极简 D1 假实现：只认 keepsakes 相关的几条 SQL。 */
class FakeD1 {
  rows: Keepsake[] = [];
  messages: Array<{ created_ms: number }> = [];
  affect: Array<{ evidence: string; created_at: number; type: string }> = [];

  prepare(sql: string) {
    const self = this;
    const exec = (args: unknown[]) => ({
      all: async () => {
        let rows = self.rows.slice();
        if (sql.includes('WHERE status = ?')) {
          rows = rows.filter((r) => r.status === args[0]);
        }
        return { results: rows };
      },
      first: async () => {
        if (sql.includes('MIN(created_ms)')) {
          const mn = self.messages.length ? Math.min(...self.messages.map((m) => m.created_ms)) : null;
          return { mn };
        }
        if (sql.includes('affect_events')) {
          const type = sql.includes("type = 'apology'") ? 'apology' : 'insult';
          const hit = self.affect.find((a) => a.type === type);
          return hit ? { evidence: hit.evidence, created_at: hit.created_at } : null;
        }
        return null;
      },
      run: async () => {
        if (sql.includes('INSERT')) {
          const [id, kind, tone, title, detail, happened_at, source, evidence, status, pinned, key, created_at] =
            args as [string, string, string, string, string, number, string, string, string, number, string, number];
          if (!self.rows.some((r) => titleKey(r.title) === key)) {
            self.rows.push({ id, kind, tone, title, detail, happened_at, source, evidence, status, pinned, created_at } as Keepsake);
          }
        }
        if (sql.includes('SET status = ?')) {
          const [status, id] = args as [string, string];
          for (const r of self.rows) if (r.id === id) r.status = status as Keepsake['status'];
        }
        return { meta: { changes: 1 } };
      },
    });
    return {
      bind: (...args: unknown[]) => exec(args),
      ...exec([]),
    };
  }
}

class FakeKV {
  store = new Map<string, string>();
  async get(k: string) {
    return this.store.get(k) ?? null;
  }
  async put(k: string, v: string) {
    this.store.set(k, v);
  }
}

function fakeEnv() {
  const db = new FakeD1();
  const kv = new FakeKV();
  return { env: { DB: db, KV: kv } as unknown as Env, db, kv };
}

function item(over: Partial<Keepsake>): Keepsake {
  return {
    id: Math.random().toString(36).slice(2),
    kind: 'first_meet',
    tone: 'warm',
    title: '第一次说话',
    detail: '',
    happened_at: T0,
    source: 'rule',
    evidence: '',
    status: 'approved',
    pinned: 1,
    created_at: T0,
    ...over,
  };
}

describe('titleKey / titleSimilarity', () => {
  it('去标点空格并小写', () => {
    expect(titleKey('第一次说话！')).toBe(titleKey('第一次 说话'));
    expect(titleKey('ABC')).toBe('abc');
  });

  it('换一种说法也能认出来', () => {
    expect(titleSimilarity(titleKey('第一次真吵架'), titleKey('第一次吵架'))).toBeGreaterThan(0.4);
    expect(titleSimilarity(titleKey('第一次说话'), titleKey('她给自己取名'))).toBeLessThan(0.3);
  });
});

describe('renderKeepsakesBlock', () => {
  it('没有条目返回空串', () => {
    expect(renderKeepsakesBlock([])).toBe('');
  });

  it('只渲染 approved 且 pinned 的', () => {
    const block = renderKeepsakesBlock([item({}), item({ title: '待审核', status: 'pending' }), item({ title: '取消置顶', pinned: 0 })]);
    expect(block).toContain('第一次说话');
    expect(block).not.toContain('待审核');
    expect(block).not.toContain('取消置顶');
  });

  it('日期按北京时间', () => {
    const block = renderKeepsakesBlock([item({ happened_at: Date.UTC(2026, 9, 25, 17, 0, 0) })]);
    expect(block).toContain('2026-10-26');
  });

  it('bitter 条目带残留说明和「别翻旧账」约束', () => {
    const block = renderKeepsakesBlock([item({ kind: 'first_fight', tone: 'bitter', title: '第一次闹别扭' })]);
    expect(block).toContain('还气不气看你现在的情绪');
    expect(block).toContain('别主动翻旧账');
  });

  it('bitter 最多 32 条', () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      item({ kind: 'hurt', tone: 'bitter', title: `伤心事${i}`, happened_at: T0 + i * 86400_000 }),
    );
    const block = renderKeepsakesBlock(many);
    expect(block.split('\n').filter((l) => l.includes('伤心事')).length).toBe(32);
  });

  it('超过 120 条保留最早的', () => {
    const many = Array.from({ length: 130 }, (_, i) =>
      item({ title: `事件${i}`, happened_at: T0 + i * 86400_000 }),
    );
    const block = renderKeepsakesBlock(many);
    expect(block).toContain('事件0');
    expect(block).not.toContain('事件129');
  });
});
describe('validateKeepsake', () => {
  it('kind 不在白名单直接丢', () => {
    const r = validateKeepsake({ kind: 'nope' as never, title: 'x', happened_at: T0, source: 'manual' });
    expect(r).toBeNull();
  });

  it('标题超长截到 24 字', () => {
    const r = validateKeepsake({
      kind: 'milestone',
      title: '一'.repeat(40),
      happened_at: T0,
      source: 'manual',
    });
    expect(r?.title.length).toBe(24);
  });

  it('first_fight 即使标成 warm 也强制 bitter', () => {
    const r = validateKeepsake({
      kind: 'first_fight',
      tone: 'warm',
      title: '第一次吵架',
      happened_at: T0,
      source: 'rule',
    });
    expect(r?.tone).toBe('bitter');
  });

  it('AI 候选的引文不是原话就丢弃', () => {
    const r = validateKeepsake(
      { kind: 'milestone', title: '某件事', happened_at: T0, source: 'ai', evidence: '编出来的话' },
      '当天备份里没有这句话',
    );
    expect(r).toBeNull();
  });

  it('引文是原话时保留', () => {
    const r = validateKeepsake(
      { kind: 'milestone', title: '某件事', happened_at: T0, source: 'ai', evidence: '以后每年这天都来' },
      '他说以后每年这天都来，好不好',
    );
    expect(r?.evidence).toBe('以后每年这天都来');
  });
});

describe('parseKeepsakeJson', () => {
  it('容忍代码块包裹', () => {
    const out = parseKeepsakeJson('```json\n{"keepsakes":[{"title":"a"}]}\n```');
    expect(out).toHaveLength(1);
  });

  it('乱码返回空数组', () => {
    expect(parseKeepsakeJson('我不知道')).toEqual([]);
    expect(parseKeepsakeJson('')).toEqual([]);
  });
});

describe('insertKeepsake', () => {
  it('重复标题第二次返回 duplicate（大小写/标点不同也算）', async () => {
    const { env } = fakeEnv();
    const a = await insertKeepsake(env, { kind: 'name', title: '我给自己取名叫千问', happened_at: T0, source: 'manual' });
    const b = await insertKeepsake(env, { kind: 'name', title: '我 给自己取名叫千问！', happened_at: T0, source: 'manual' });
    expect(a).toBe('inserted');
    expect(b).toBe('duplicate');
  });

  it('手动新增直接 approved，AI 候选是 pending', async () => {
    const { env, db } = fakeEnv();
    await insertKeepsake(env, { kind: 'milestone', title: '手动', happened_at: T0, source: 'manual' });
    await insertKeepsake(env, { kind: 'milestone', title: '自动', happened_at: T0, source: 'ai' });
    const rows = await loadKeepsakes(env);
    expect(rows.find((r) => r.title === '手动')?.status).toBe('approved');
    expect(rows.find((r) => r.title === '自动')?.status).toBe('pending');
    expect(db.rows.length).toBe(2);
  });

  it('单日 AI 入册上限 4 条', async () => {
    const { env } = fakeEnv();
    for (const t of ['事件一', '事件二', '事件三', '事件四', '事件五']) {
      await insertKeepsake(env, { kind: 'milestone', title: t, happened_at: T0, source: 'ai' }, '', T0);
    }
    expect((await loadKeepsakes(env)).length).toBe(4);
  });
});

describe('detectRuleKeepsakes', () => {
  it('first_meet 只写一次', async () => {
    const { env, db } = fakeEnv();
    db.messages = [{ created_ms: T0 - 86400_000 }];
    const first = await detectRuleKeepsakes(env, T0, {});
    for (const k of first) await insertKeepsake(env, k);
    const second = await detectRuleKeepsakes(env, T0, {});
    expect(first.some((k) => k.kind === 'first_meet')).toBe(true);
    expect(second.some((k) => k.kind === 'first_meet')).toBe(false);
  });

  it('首次闹别扭记为 bitter', async () => {
    const { env, db } = fakeEnv();
    db.affect = [{ evidence: '你个笨蛋', created_at: T0 - 3600_000, type: 'insult' }];
    const hits = await detectRuleKeepsakes(env, T0, {});
    expect(hits.find((k) => k.kind === 'first_fight')?.tone).toBe('bitter');
  });

  it('约定句会被记下来', async () => {
    const { env } = fakeEnv();
    const hits = await detectRuleKeepsakes(env, T0, { conversation: '他说以后每年这天都来陪我' });
    expect(hits.some((k) => k.kind === 'promise')).toBe(true);
  });
});

describe('extractNameFromMemory', () => {
  it('只认明确写法', () => {
    expect(extractNameFromMemory('我叫千问')).toBe('千问');
    expect(extractNameFromMemory('平时你叫我什么来着')).toBeNull();
  });
});
