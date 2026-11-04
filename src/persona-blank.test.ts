import { describe, expect, it } from 'vitest';
import { buildSystemPrompt } from './prompt';
import { resolvePersona } from './persona';
import type { DayContext } from './holidays';

/**
 * 清空重置期：PERSONA_PROFILE=none 时提示词里不能残留任何一句人设。
 *
 * 之前踩过：清空记忆后她仍然自称「本小姐」、仍然叫他「主人」——
 * 因为空环境变量会回退到开源默认值。blank 模式把这个回退也关掉了。
 */
const ctx: DayContext = {
  date: '2026-11-04',
  weekday: '周三',
  holiday_note: '平常工作日',
} as unknown as DayContext;

const base = {
  now: new Date('2026-11-04T10:00:00+08:00'),
  ctx,
  memory: '',
  channel: 'web' as const,
  persona: resolvePersona({ PERSONA_PROFILE: 'none' }),
};

describe('PERSONA_PROFILE=none', () => {
  it('resolvePersona 返回空白人设', () => {
    const p = resolvePersona({ PERSONA_PROFILE: 'none', PERSONA_SELF_CALL: '本小姐' });
    expect(p.blank).toBe(true);
    expect(p.selfCall).toBe('');
    expect(p.role).toBe('');
  });

  it('人设清空时：没有内置人设，但行为规则还在', () => {
    const prompt = buildSystemPrompt(base);
    for (const banned of ['本小姐', '专属 AI 女友', '嘴硬']) {
      expect(prompt, '残留: ' + banned).not.toContain(banned);
    }
    // 规则不跟人设一起消失：她仍要知道怎么用记忆、怎么说话
    for (const rule of ['## 你们的称呼', '## 记忆怎么用', '## 你说话的样子', '分清楚谁在哪儿']) {
      expect(prompt, '缺规则: ' + rule).toContain(rule);
    }
  });

  it('时间/环境这类事实仍然保留（不然她连现在几点都不知道）', () => {
    const prompt = buildSystemPrompt(base);
    expect(prompt).toContain('## 此刻');
    expect(prompt).toContain('2026-11-04');
  });

  it('默认档位行为不变：没配 PERSONA_PROFILE 时仍有人设', () => {
    const prompt = buildSystemPrompt({ ...base, persona: resolvePersona({}) });
    expect(prompt).toContain('本小姐');
  });
});
