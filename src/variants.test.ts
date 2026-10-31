import { describe, expect, it } from 'vitest';
import { actionForKind, decideVariant, newVariant, type VariantMetrics } from './variants';
import { tierOf } from './policy';

function metrics(over: Partial<VariantMetrics> = {}): VariantMetrics {
  return { samples: 60, hitRate: 0.9, avgItems: 4, falsePositiveRate: 0.05, ...over };
}

describe('变体档位', () => {
  it('三类变体都归 B 档（必须隔离验证）', () => {
    expect(tierOf(actionForKind('prompt'))).toBe('B');
    expect(tierOf(actionForKind('extractor'))).toBe('B');
    expect(tierOf(actionForKind('retrieval'))).toBe('B');
  });
});

describe('decideVariant', () => {
  it('命中率涨了、误召没变：保留', () => {
    const v = decideVariant(metrics(), metrics({ hitRate: 0.95 }));
    expect(v.keep).toBe(true);
    expect(v.reason).toContain('+5.0');
  });

  it('提升不到 2 个百分点：拒绝', () => {
    const v = decideVariant(metrics(), metrics({ hitRate: 0.91 }));
    expect(v.keep).toBe(false);
    expect(v.reason).toContain('低于');
  });

  it('误召率上升：一票否决，哪怕命中率更高', () => {
    const v = decideVariant(metrics(), metrics({ hitRate: 0.99, falsePositiveRate: 0.1 }));
    expect(v.keep).toBe(false);
    expect(v.reason).toContain('误召率');
  });

  it('靠多塞条目换命中率：不算改进', () => {
    const v = decideVariant(metrics(), metrics({ hitRate: 0.99, avgItems: 6 }));
    expect(v.keep).toBe(false);
    expect(v.reason).toContain('多塞');
  });

  it('样本不足不许裁决', () => {
    const v = decideVariant(metrics({ samples: 5 }), metrics({ samples: 5, hitRate: 0.99 }));
    expect(v.keep).toBe(false);
    expect(v.reason).toContain('样本不足');
  });

  it('命中率不升反降：拒绝', () => {
    const v = decideVariant(metrics(), metrics({ hitRate: 0.8 }));
    expect(v.keep).toBe(false);
  });

  it('阈值可调（minGain=0 时小提升也算赢）', () => {
    const v = decideVariant(metrics(), metrics({ hitRate: 0.905 }), { minGain: 0 });
    expect(v.keep).toBe(true);
  });
});

describe('newVariant', () => {
  it('新提案一律 pending，不上线', () => {
    const v = newVariant({
      kind: 'prompt',
      target: 'persona_drift_line',
      change: '把漂移提示从感叹句改成陈述句',
      intent: '线下评估里陈述句更少引发她反驳',
      evidence: ['eval:golden-memory 92/97'],
    });
    expect(v.status).toBe('pending');
    expect(v.id.startsWith('var_')).toBe(true);
  });

  it('超长文本被截断', () => {
    const v = newVariant({
      kind: 'extractor',
      target: 'event_quotes_rule',
      change: 'x'.repeat(5000),
      intent: 'i',
      evidence: ['e'],
    });
    expect(v.change.length).toBeLessThanOrEqual(2000);
  });

  it('证据最多留 10 条', () => {
    const v = newVariant({
      kind: 'retrieval',
      target: 'expand_budget',
      change: 'c',
      intent: 'i',
      evidence: Array.from({ length: 30 }, (_, i) => 'e' + i),
    });
    expect(v.evidence).toHaveLength(10);
  });
});
