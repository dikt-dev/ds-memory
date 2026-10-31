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
