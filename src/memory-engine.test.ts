import { describe, expect, it, vi } from 'vitest';
import {
  capRecallText,
  isCovered,
  resolveRecall,
  withDeadline,
  RECALL_DEADLINE_MS,
} from './memory-engine';
import type { Env } from './types';

const NL = String.fromCharCode(10);

describe('withDeadline', () => {
  it('在预算内完成就返回真实结果', async () => {
    await expect(withDeadline(Promise.resolve('ok'), 50, 'fallback')).resolves.toBe('ok');
  });

  it('超时返回 fallback 并触发回调', async () => {
    const onTimeout = vi.fn();
    const slow = new Promise<string>((resolve) => setTimeout(() => resolve('late'), 200));
    const value = await withDeadline(slow, 10, 'fallback', onTimeout);
    expect(value).toBe('fallback');
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('deadline 非正数时直接返回 fallback', async () => {
    await expect(withDeadline(Promise.resolve('ok'), 0, 'fallback')).resolves.toBe('fallback');
  });
});

describe('capRecallText（回忆封顶）', () => {
  it('条数不超上限时原样返回', () => {
    const text = ['## 相关记忆', '- a', '- b'].join(NL);
    expect(capRecallText(text, 8)).toBe(text);
  });

  it('超过上限时保留前 N 条并标注还有几条', () => {
    const items = Array.from({ length: 12 }, (_, i) => `- 第${i + 1}条`);
    const text = ['## 相关记忆', ...items].join(NL);
    const out = capRecallText(text, 8);
    expect(out.split(NL).filter((l) => l.startsWith('- '))).toHaveLength(9); // 8 条 + 折叠行
    expect(out).toContain('第8条');
    expect(out).not.toContain('第9条');
    expect(out).toContain('还有 4 条相关记忆没展开');
    expect(out).toContain('## 相关记忆');
  });

  it('单条过长时截断并加省略号', () => {
    const long = '- ' + 'x'.repeat(300);
    const out = capRecallText(['## 相关记忆', long, ...Array(9).fill('- y')].join(NL), 2, 50);
    expect(out).toContain('x'.repeat(50) + '…');
    expect(out).not.toContain('x'.repeat(51));
  });

  it('空输入返回空串', () => {
    expect(capRecallText('')).toBe('');
  });
});

describe('resolveRecall 门控', () => {
  it('低信号提问直接跳过，连 legacy 都不跑（P2-5）', async () => {
    const env = {} as Env;
    const r = await resolveRecall(env, { query: '你好', mode: 'legacy', channel: 'web' });
    expect(r.skipped).toBe(true);
    expect(r.text).toBe('');
    expect(r.timedOut).toBe(false);
  });

  it('默认预算按实测校准到 3500ms（并行后是 max 而非 sum）', () => {
    expect(RECALL_DEADLINE_MS).toBe(3500);
  });
});

describe('覆盖率短路（召回只带提示词里没有的）', () => {
  const chunk = (content: string, id: string) => ({
    id,
    source: 'fact' as const,
    sourceId: id,
    section: '共同经历',
    content,
    date: '26-11-07',
    keywords: [],
    tags: [],
    importance: 5,
    contentHash: id,
    updatedAt: 1,
    useCount: 0,
    lastUsedAt: null,
    confirmedCount: 0,
    pinned: false,
    vec: null,
    subject: 'shared',
  });

  const envWith = (chunks: unknown[], extra: Record<string, string> = {}) =>
    ({
      KV: {
        get: async () => chunks,
        put: async () => undefined,
        delete: async () => undefined,
      },
      DB: {
        prepare: () => ({
          bind: () => ({
            run: async () => ({ meta: { changes: 0 } }),
            first: async () => null,
            all: async () => ({ results: [] }),
          }),
          run: async () => ({ meta: { changes: 0 } }),
          first: async () => null,
          all: async () => ({ results: [] }),
        }),
      },
      ...extra,
    }) as unknown as Env;

  const LINE = '她怕打雷，晚上会戴着耳机睡';

  it('全部候选都在注入内容里 → 空召回，且不调选择器', async () => {
    const env = envWith([chunk(LINE, 'a')]);
    const r = await resolveRecall(env, {
      query: '你还记得我怕打雷那件事吗',
      mode: 'next',
      channel: 'mobile',
      injectedText: ['## 长期记忆', '- [26-11-07] ' + LINE].join(NL),
    });
    expect(r.text).toBe('');
    expect(r.covered).toBe(1);
    expect(r.uncovered).toBe(0);
    expect(r.selectorSkipped).toBe(true);
  });

  it('注入内容里没有 → 正常参与召回', async () => {
    const env = envWith([chunk(LINE, 'a')]);
    const r = await resolveRecall(env, {
      query: '你还记得我怕打雷那件事吗',
      mode: 'next',
      channel: 'mobile',
      injectedText: '## 长期记忆（别的内容）',
    });
    expect(r.covered).toBe(0);
    expect(r.uncovered).toBe(1);
    expect(r.selectorSkipped).toBe(false);
    expect(r.text).toContain('打雷');
  });

  it('RECALL_SKIP_COVERED=off 时回到旧行为', async () => {
    const env = envWith([chunk(LINE, 'a')], { RECALL_SKIP_COVERED: 'off' });
    const r = await resolveRecall(env, {
      query: '你还记得我怕打雷那件事吗',
      mode: 'next',
      channel: 'mobile',
      injectedText: ['## 长期记忆', '- [26-11-07] ' + LINE].join(NL),
    });
    expect(r.text).toContain('打雷');
    expect(r.selectorSkipped).toBe(false);
  });

  it('isCovered：短条目不算覆盖，避免 8 字以下误杀', () => {
    expect(isCovered({ content: '怕打雷' }, '他怕打雷')).toBe(false);
    expect(isCovered({ content: '她怕打雷，晚上戴耳机' }, '前言 她怕打雷，晚上戴耳机 后记')).toBe(true);
  });
});

describe('指标写盘不阻塞回复', () => {
  const chunk = {
    id: 'x1',
    source: 'fact' as const,
    sourceId: 'x1',
    section: '共同经历',
    content: '他云请客点砂锅粥，加了双份虾',
    date: '26-11-07',
    keywords: [],
    tags: [],
    importance: 5,
    contentHash: 'x1',
    updatedAt: 1,
    useCount: 0,
    lastUsedAt: null,
    confirmedCount: 0,
    pinned: false,
    vec: null,
    subject: 'shared',
  };

  it('D1 写永远不 resolve 时，召回仍然按时返回，写盘交给 waitUntil', async () => {
    const never = new Promise(() => undefined);
    const env = {
      KV: { get: async () => [chunk], put: async () => undefined, delete: async () => undefined },
      DB: {
        prepare: () => ({
          bind: () => ({ run: () => never, first: async () => null, all: async () => ({ results: [] }) }),
          run: () => never,
          first: async () => null,
          all: async () => ({ results: [] }),
        }),
      },
    } as unknown as Env;

    const waits: Promise<unknown>[] = [];
    const started = Date.now();
    const r = await resolveRecall(env, {
      query: '砂锅粥是哪家',
      mode: 'next',
      channel: 'mobile',
      injectedText: '## 别的记忆',
      waitUntil: (p) => waits.push(p),
    });
    const elapsed = Date.now() - started;
    expect(r.text).toContain('砂锅粥');
    expect(elapsed).toBeLessThan(200);
    expect(waits.length).toBeGreaterThan(0); // 指标仍然被提交，只是不 await
  });
});
