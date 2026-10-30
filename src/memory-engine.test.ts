import { describe, expect, it, vi } from 'vitest';
import { capRecallText, resolveRecall, withDeadline, RECALL_DEADLINE_MS } from './memory-engine';
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

  it('默认预算按实测校准到 3000ms（并行后是 max 而非 sum）', () => {
    expect(RECALL_DEADLINE_MS).toBe(3000);
  });
});