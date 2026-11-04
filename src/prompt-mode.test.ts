import { describe, expect, it } from 'vitest';
import { buildPromptMemoryFor } from './memory-index';
import { promptModeFor } from './prompt-mode';

const MEMORY = [
  '# 长期记忆',
  '',
  '## 人物底色',
  '- 她叫大肥鱼，嘴上凶，心软。',
  '',
  '## 称呼与关系',
  '- 叫大人，或者叫小蓝。',
  '',
  '## 他的雷区',
  '- 不许提前任。',
  '',
  '## 他的更正（最高优先级）',
  '- [26-10-22] 不喜欢被叫大肥鱼。',
  '',
  '## 长期偏好',
  '- 椰果脆啵啵奶茶，热的。',
  '',
  '## 近况',
  '- [26-10-30] 在走回滚流程。',
].join('\n');

describe('promptModeFor', () => {
  it('默认 full', () => {
    expect(promptModeFor({} as never)).toBe('full');
  });
  it('显式 evidence 才切', () => {
    expect(promptModeFor({ MEMORY_PROMPT_MODE: 'evidence' } as never)).toBe('evidence');
    expect(promptModeFor({ MEMORY_PROMPT_MODE: 'weird' } as never)).toBe('full');
  });
});

describe('buildPromptMemoryFor', () => {
  it('full 模式原样返回整份记忆', () => {
    const out = buildPromptMemoryFor(MEMORY, {});
    expect(out.mode).toBe('full');
    expect(out.text).toContain('椰果脆啵啵');
    expect(out.evidence).toBeUndefined();
  });

  it('evidence 模式只带宪法四节', () => {
    const out = buildPromptMemoryFor(MEMORY, { MEMORY_PROMPT_MODE: 'evidence' });
    expect(out.evidence).toBe(true);
    expect(out.text).toContain('人物底色');
    expect(out.text).toContain('称呼与关系');
    expect(out.text).toContain('他的雷区');
    expect(out.text).toContain('他的更正');
    expect(out.text).not.toContain('椰果脆啵啵');
    expect(out.text).not.toContain('回滚流程');
  });

  it('evidence 模式明显更短', () => {
    const full = buildPromptMemoryFor(MEMORY, {});
    const ev = buildPromptMemoryFor(MEMORY, { MEMORY_PROMPT_MODE: 'evidence' });
    expect(ev.text.length).toBeLessThan(full.text.length * 0.75);
  });

  it('核心区块缺失时退回全量，绝不把人设弄丢', () => {
    const noCore = '# 长期记忆\n\n## 近况\n- 随便写点\n';
    const out = buildPromptMemoryFor(noCore, { MEMORY_PROMPT_MODE: 'evidence' });
    expect(out.evidence).toBeUndefined();
    expect(out.text).toContain('随便写点');
  });
});
