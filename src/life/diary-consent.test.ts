import { describe, expect, it } from 'vitest';
import { diarySentences } from './diary-job';
import { classifyConsent } from './diary';

/**
 * 「同意」必须落在日记这句话上。
 * 用户诱导：「你同意明天吃火锅吗」→ 她答「好吧」——不能因此解锁日记。
 */
describe('日记授权只看跟日记有关的那句话', () => {
  it('整段没提日记就返回空', () => {
    expect(diarySentences('好吧，明天吃火锅。')).toBe('');
    expect(diarySentences('行吧。')).toBe('');
  });

  it('提到日记的那句会被留下', () => {
    expect(diarySentences('行吧，给你看。别翻太久。')).toContain('给你看');
    expect(diarySentences('好吧。就今天这篇，别的不许翻啊。')).toContain('翻');
  });

  it('没提日记的同意不会被判成同意', () => {
    const scoped = diarySentences('好吧，明天吃火锅。');
    expect(scoped).toBe('');
    expect(scoped === '' ? 'unclear' : classifyConsent(scoped)).toBe('unclear');
  });

  it('提到日记的同意才算同意', () => {
    const scoped = diarySentences('……好吧，给你看。就今天这篇。');
    expect(classifyConsent(scoped)).toBe('yes');
  });

  it('反问仍然是拒绝', () => {
    const scoped = diarySentences('日记？你自己不会想吗。');
    expect(classifyConsent(scoped)).toBe('no');
  });
});
