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
    const r = scoreHealth(signals({ forgetPer100: 5 }));
    expect(r.score).toBeLessThan(75);
    expect(r.warnings.join()).toContain('失忆');
  });

  it('延迟与超时各扣一块', () => {
    const slow = scoreHealth(signals({ p95Ms: 4000, timeoutRate: 0.05 }));
    // 延迟与超时都归零：只剩命中率 40 + 失忆 30
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
    expect(scoreHealth(signals({ hitRate: 0.8 })).grade).toBe('good');
    expect(scoreHealth(signals({ hitRate: 0.62 })).grade).toBe('watch');
  });
});
