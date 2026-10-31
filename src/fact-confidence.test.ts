import { describe, expect, it } from 'vitest';
import {
  applySignal,
  confidenceForSource,
  confidenceTag,
  isLowTrust,
  LOW_TRUST_THRESHOLD,
  mergeConfidence,
  MIN_CONFIDENCE,
  penalizeCorrected,
  quoteGate,
} from './fact-confidence';

describe('初始置信度', () => {
  it('用户纠正过的话最高，模型推断最低', () => {
    expect(confidenceForSource('correction')).toBeGreaterThan(confidenceForSource('memory'));
    expect(confidenceForSource('memory')).toBeGreaterThan(confidenceForSource('conversation'));
    expect(confidenceForSource('conversation')).toBeGreaterThan(confidenceForSource('inference'));
  });

  it('未知来源兜底 0.5，不崩', () => {
    expect(confidenceForSource('nope' as never)).toBe(0.5);
  });
});

describe('信号', () => {
  it('用户确认加可信度，纠正降权', () => {
    const base = 0.6;
    expect(applySignal(base, 'user_confirm')).toBeGreaterThan(base);
    expect(applySignal(base, 'user_correct')).toBeLessThan(base);
  });

  it('重复提及几乎不改变（她自己说不能变可信）', () => {
    expect(applySignal(0.6, 'repeat')).toBeLessThanOrEqual(0.62);
  });

  it('上下限被夹住', () => {
    expect(applySignal(1, 'user_confirm')).toBe(1);
    expect(applySignal(0.21, 'user_correct')).toBe(MIN_CONFIDENCE);
    expect(applySignal(0.2, 'user_correct')).toBe(MIN_CONFIDENCE);
  });

  it('NaN 输入不会污染分数', () => {
    expect(applySignal(Number.NaN, 'decay')).toBe(MIN_CONFIDENCE);
  });
});

describe('低可信与标签', () => {
  it('低于阈值算低可信', () => {
    expect(isLowTrust(LOW_TRUST_THRESHOLD - 0.01)).toBe(true);
    expect(isLowTrust(LOW_TRUST_THRESHOLD)).toBe(false);
  });

  it('标签分三档', () => {
    expect(confidenceTag(0.9)).toBe('确定');
    expect(confidenceTag(0.7)).toBe('较可信');
    expect(confidenceTag(0.3)).toBe('存疑');
  });
});

describe('证据门', () => {
  it('全部对上：通过', () => {
    const r = quoteGate(['今天不走回滚', '明天再说'], ['今天不走回滚', '明天再说']);
    expect(r.fabricated).toBe(false);
    expect(r.kept).toHaveLength(2);
    expect(r.dropped).toBe(0);
  });

  it('一句都没对上：判定为编造，整条丢弃', () => {
    const r = quoteGate(['她从来没有这么说过'], []);
    expect(r.fabricated).toBe(true);
    expect(r.ok).toBe(false);
  });

  it('部分对上：只保留对上的部分', () => {
    const r = quoteGate(['对的一句', '编的一句'], ['对的一句']);
    expect(r.ok).toBe(true);
    expect(r.kept).toEqual(['对的一句']);
    expect(r.dropped).toBe(1);
  });

  it('模型没给引文：不算编造，靠 summary 兜底', () => {
    const r = quoteGate([], []);
    expect(r.fabricated).toBe(false);
    expect(r.ok).toBe(true);
  });

  it('空白引文不计入', () => {
    const r = quoteGate(['   ', ''], []);
    expect(r.fabricated).toBe(false);
  });
});

describe('合并与惩罚', () => {
  it('重复出现取较高者并轻微上浮', () => {
    expect(mergeConfidence(0.6, 0.7)).toBeCloseTo(0.72, 5);
  });

  it('已被纠正的事实再降一档，且不会低于下限', () => {
    expect(penalizeCorrected({ confidence: 0.6 })).toBeCloseTo(0.25, 5);
    expect(penalizeCorrected({ confidence: 0.2 })).toBe(MIN_CONFIDENCE);
  });
});
