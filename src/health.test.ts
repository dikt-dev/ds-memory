import { describe, expect, it } from 'vitest';
import { scoreHealth, type HealthSignals } from './health';

function signals(over: Partial<HealthSignals> = {}): HealthSignals {
  return {
    days: 7,
    samples: 100,
    hitRate: 0.95,
    timeoutRate: 0,
    p50Ms: 900,
    p95Ms: 1400,
    avgItems: 4,
    forgetComplaints: 0,
    userMessages: 300,
    forgetPer100: 0,
    actions: 3,
    ...over,
  };
}

describe('scoreHealth', () => {
  it('全项健康接近满分', () => {
    const r = scoreHealth(signals());
    expect(r.score).toBeGreaterThan(90);
    expect(r.grade).toBe('good');
    expect(r.warnings).toEqual([]);
  });

  it('命中率低会拉低分数并给警告', () => {
    const r = scoreHealth(signals({ hitRate: 0.55 }));
    expect(r.score).toBeLessThan(70);
    expect(r.warnings.join()).toContain('命中率');
  });

  it('失忆抱怨是最硬的负分信号', () => {
    // 抱怨归零只扣 25 分，但加上命中率不满分会掉到 70 以下
    const r = scoreHealth(signals({ forgetPer100: 5, hitRate: 0.85 }));
    expect(r.score).toBeLessThan(75);
    expect(r.warnings.join()).toContain('失忆');
  });

  it('延迟与超时各扣一块', () => {
    const slow = scoreHealth(signals({ p95Ms: 4000, timeoutRate: 0.05 }));
    // 延迟与超时都归零：只剩命中率 35 + 失忆 25 + 降级 10
    expect(slow.score).toBeLessThanOrEqual(70);
    expect(slow.grade).toBe('watch');
    expect(slow.warnings.join()).toContain('延迟');
    expect(slow.warnings.join()).toContain('超时');
  });

  it('没有样本时给警告，不假装健康', () => {
    const r = scoreHealth(signals({ samples: 0, hitRate: 0 }));
    expect(r.warnings.join()).toContain('没有召回样本');
  });

  it('分数落在 0~100 之间', () => {
    const worst = scoreHealth(
      signals({ hitRate: 0, timeoutRate: 0.5, p95Ms: 9000, forgetPer100: 20 }),
    );
    expect(worst.score).toBeGreaterThanOrEqual(0);
    expect(worst.score).toBeLessThanOrEqual(100);
    expect(worst.grade).toBe('bad');
  });

  it('各分项权重加起来是 100', () => {
    const r = scoreHealth(signals());
    expect(r.components.reduce((s, c) => s + c.weight, 0)).toBe(100);
  });

  it('分项不超过各自权重', () => {
    const r = scoreHealth(signals({ hitRate: 1, p95Ms: 0, timeoutRate: 0, forgetPer100: 0 }));
    for (const c of r.components) expect(c.score).toBeLessThanOrEqual(c.weight);
  });

  it('grade 三档边界', () => {
    // 命中率 0.8 → 命中 26.25 + 25 + 15 + 15 + 10 = 91.25
    expect(scoreHealth(signals({ hitRate: 0.8 })).grade).toBe('good');
    // 0.62 → 10.5 + 65 = 75.5，恰好还是 good（边界在 75）
    expect(scoreHealth(signals({ hitRate: 0.62 })).grade).toBe('good');
    // 0.55 → 4.375 + 65 = 69.4，落进 watch
    expect(scoreHealth(signals({ hitRate: 0.55 })).grade).toBe('watch');
  });

  it('静默降级会扣分并给警告', () => {
    const clean = scoreHealth(signals());
    const degraded = scoreHealth(signals({ degradations: 140, degradationsPerDay: 20 }));
    expect(clean.score - degraded.score).toBeCloseTo(10, 5);
    expect(degraded.warnings.join()).toContain('静默降级');
    expect(degraded.components.find((c) => c.name === '静默降级')?.score).toBe(0);
  });

  it('降级只影响它自己那一项', () => {
    const r = scoreHealth(signals({ degradationsPerDay: 5 }));
    const deg = r.components.find((c) => c.name === '静默降级');
    expect(deg?.score).toBe(7.5);
    expect(r.components.find((c) => c.name === '召回命中率')?.score).toBe(35);
  });
});
