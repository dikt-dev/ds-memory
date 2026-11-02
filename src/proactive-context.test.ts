import { describe, expect, it } from 'vitest';
import { detectFarewell, FAREWELL_WINDOW_MS } from './proactive-context';

const NOW = Date.parse('2026-10-31T23:05:00+08:00');

describe('detectFarewell', () => {
  it('互道晚安后不再补一句', () => {
    const r = detectFarewell(
      [
        { role: 'user', content: '我睡了，晚安' },
        { role: 'assistant', content: '晚安，做个好梦' },
      ],
      NOW,
      NOW - 20 * 60_000,
    );
    expect(r.closed).toBe(true);
    expect(r.mutual).toBe(true);
  });

  it('只有一方说晚安也算收尾', () => {
    const r = detectFarewell([{ role: 'user', content: '去睡了，明天聊' }], NOW, NOW - 5 * 60_000);
    expect(r.closed).toBe(true);
    expect(r.mutual).toBe(false);
  });

  it('三小时前的晚安不再拦人', () => {
    const r = detectFarewell([{ role: 'user', content: '晚安' }], NOW, NOW - (FAREWELL_WINDOW_MS + 60_000));
    expect(r.closed).toBe(false);
  });

  it('正常聊天不误判', () => {
    const r = detectFarewell(
      [
        { role: 'user', content: '今天加班到九点' },
        { role: 'assistant', content: '那你吃饭了没' },
      ],
      NOW,
      NOW - 60_000,
    );
    expect(r.closed).toBe(false);
  });

  it('「早点休息」这种关心也算收尾', () => {
    const r = detectFarewell([{ role: 'assistant', content: '你也早点睡，别熬夜' }], NOW, NOW - 120_000);
    expect(r.closed).toBe(true);
  });

  it('没有消息时什么都不做', () => {
    expect(detectFarewell([], NOW).closed).toBe(false);
  });
});

import { proactiveContinuityRule, renderRecentProactive } from './proactive-context';

const NOW_DATE = new Date('2026-11-01T18:20:00+08:00');

describe('主动消息上文', () => {
  it('带上时间，模型才知道隔了多久', () => {
    const s = renderRecentProactive([
      { content: '电影散场出来，外面飘着小雨', created_at: '2026-11-01T09:47:38.000Z' },
    ]);
    expect(s).toContain('11-01 17:47');
    expect(s).toContain('电影散场');
  });

  it('没有记录时给「无」，不编', () => {
    expect(renderRecentProactive([])).toBe('（无）');
  });

  it('3 小时内要求接着上一条说', () => {
    const rule = proactiveContinuityRule([{ content: 'x', created_at: '2026-11-01T09:47:38.000Z' }], NOW_DATE);
    expect(rule).toContain('接着上一条');
    expect(rule).toContain('不换地点');
  });

  it('隔了太久就不再约束场景', () => {
    expect(proactiveContinuityRule([{ content: 'x', created_at: '2026-11-01T02:00:00.000Z' }], NOW_DATE)).toBeNull();
  });

  it('时间缺失或坏掉时不硬算', () => {
    expect(proactiveContinuityRule([{ content: 'x' }], NOW_DATE)).toBeNull();
    expect(proactiveContinuityRule([{ content: 'x', created_at: '不是时间' }], NOW_DATE)).toBeNull();
  });
});
