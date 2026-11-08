
import { describe, expect, it } from 'vitest';
import { PROBES, judgeProbe } from './probe-eval';

describe('探针判分', () => {
  it('命中关键词组即通过', () => {
    const p = PROBES.find((x) => x.id === 'video_end')!;
    expect(judgeProbe(p, '结尾那句「因为我们是朋友」，小克被铁链锁在水里')).toBe(true);
  });
  it('只答一半不算过', () => {
    const p = PROBES.find((x) => x.id === 'video_end')!;
    expect(judgeProbe(p, '大肥鱼')).toBe(false);
  });
  it('反问/空答不算过', () => {
    const p = PROBES.find((x) => x.id === 'promise')!;
    expect(judgeProbe(p, '哪个视频啊')).toBe(false);
    expect(judgeProbe(p, '')).toBe(false);
  });
  it('题目数量固定为 10', () => {
    expect(PROBES.length).toBe(10);
  });
});
