import { describe, expect, it } from 'vitest';
import { buildDayContext } from './holidays';
import { buildSystemPrompt, normalizeChannel } from './prompt';

describe('buildSystemPrompt', () => {
  const ctx = buildDayContext('2026-10-21');

  it('注入记忆、日期、节假日、天气与渠道', () => {
    const prompt = buildSystemPrompt({
      now: new Date('2026-10-21T01:00:00Z'),
      ctx,
      memory: '- [2026-10-01] 用户生活在杭州。',
      weather: { city: '杭州', temp_c: 18.5, desc: '晴' },
      channel: 'web',
    });
    expect(prompt).toContain('用户生活在杭州');
    expect(prompt).toContain('2026-10-21 星期三');
    expect(prompt).toContain('工作日');
    expect(prompt).toContain('杭州 晴，18.5°C');
    expect(prompt).toContain('消息来源：网页');
  });

  it('不再把历史对话拼进 system（避免与 messages 重复）', () => {
    const prompt = buildSystemPrompt({
      now: new Date('2026-10-21T01:00:00Z'),
      ctx,
      memory: 'x',
      channel: 'web',
    });
    expect(prompt).not.toContain('## 最近对话');
    expect(prompt).not.toContain('用户：');
  });

  it('稳定内容（记忆）排在易变内容（时间）之前，保证前缀可缓存', () => {
    const prompt = buildSystemPrompt({
      now: new Date('2026-10-21T01:00:00Z'),
      ctx,
      memory: '- [2026-10-01] 用户生活在杭州。',
      channel: 'web',
    });
    const memoryAt = prompt.indexOf('用户生活在杭州');
    const timeAt = prompt.indexOf('## 当前时间与环境');
    expect(memoryAt).toBeGreaterThan(-1);
    expect(timeAt).toBeGreaterThan(-1);
    expect(memoryAt).toBeLessThan(timeAt);
  });

  it('AstrBot 渠道显示对应来源', () => {
    const prompt = buildSystemPrompt({
      now: new Date('2026-10-21T01:00:00Z'),
      ctx,
      memory: 'x',
      channel: 'astrobot',
    });
    expect(prompt).toContain('消息来源：AstrBot');
  });

  it('无记忆时给出占位，不报错', () => {
    const prompt = buildSystemPrompt({
      now: new Date('2026-10-21T01:00:00Z'),
      ctx,
      memory: '',
      channel: 'web',
    });
    expect(prompt).toContain('（暂无记忆）');
  });
});

describe('normalizeChannel', () => {
  it('合法渠道原样返回', () => {
    expect(normalizeChannel('mobile')).toBe('mobile');
    expect(normalizeChannel('pet')).toBe('pet');
    expect(normalizeChannel('astrobot')).toBe('astrobot');
  });

  it('非法/缺失回退默认值', () => {
    expect(normalizeChannel(undefined)).toBe('web');
    expect(normalizeChannel('unknown-channel')).toBe('web');
    expect(normalizeChannel(42)).toBe('web');
    expect(normalizeChannel(undefined, 'astrobot')).toBe('astrobot');
  });
});
