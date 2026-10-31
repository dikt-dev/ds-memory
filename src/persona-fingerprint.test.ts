import { describe, expect, it } from 'vitest';
import { buildFingerprint, compareFingerprints } from './persona-fingerprint';

describe('buildFingerprint', () => {
  it('空输入全零，不除零', () => {
    const f = buildFingerprint([]);
    expect(f.messages).toBe(0);
    expect(f.avgChars).toBe(0);
  });

  it('统计句长、语气词、称呼、表情', () => {
    const f = buildFingerprint(['本小姐知道呀', '笨蛋呢']);
    expect(f.messages).toBe(2);
    expect(f.addressPerMsg).toBe(1);
    expect(f.particlesPerMsg).toBeGreaterThan(0);
  });

  it('表情单独计数', () => {
    const f = buildFingerprint(['好呀😊', '行😊']);
    expect(f.emojiPerMsg).toBe(1);
  });
});

describe('compareFingerprints', () => {
  const base = { messages: 20, avgChars: 20, particlesPerMsg: 1, addressPerMsg: 0.5, emojiPerMsg: 0.4 };

  it('几乎没变化：不报警', () => {
    const c = compareFingerprints(base, { ...base, avgChars: 21 });
    expect(c.drifted).toBe(false);
    expect(c.reasons).toEqual([]);
  });

  it('句长翻倍：报警并说明哪个维度', () => {
    const c = compareFingerprints(base, { ...base, avgChars: 40 });
    expect(c.drifted).toBe(true);
    expect(c.reasons.join()).toContain('平均句长');
  });

  it('语气词消失（变冷）：报警', () => {
    const c = compareFingerprints(base, { ...base, particlesPerMsg: 0.2 });
    expect(c.drifted).toBe(true);
    expect(c.reasons.join()).toContain('语气词');
  });

  it('样本太少不做判断', () => {
    const c = compareFingerprints({ ...base, messages: 2 }, base);
    expect(c.drifted).toBe(false);
    expect(c.reasons.join()).toContain('样本太少');
  });

  it('阈值可调', () => {
    // 20 → 30 是 50% 偏差：阈值 0.6 时不报警，0.4 时会报警
    const c = compareFingerprints(base, { ...base, avgChars: 30 }, 0.6);
    expect(compareFingerprints(base, { ...base, avgChars: 30 }, 0.4).drifted).toBe(true);
    expect(c.drifted).toBe(false);
  });

  it('基线为零时不会除零崩溃', () => {
    const zero = { messages: 10, avgChars: 0, particlesPerMsg: 0, addressPerMsg: 0, emojiPerMsg: 0 };
    expect(() => compareFingerprints(zero, base)).not.toThrow();
  });
});
