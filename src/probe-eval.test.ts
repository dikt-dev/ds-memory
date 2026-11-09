
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

describe('多发表决与历史', () => {
  it('三发里过半数才算过', async () => {
    const { scoreProbeAnswers } = await import('./probe-eval');
    const env = {
      KV: { put: async function () { return undefined; } },
      DB: { prepare: function () { return { bind: function () { return { run: async function () { return { meta: { changes: 1 } }; } }; } }; } },
    };
    const answers = [];
    for (const p of PROBES) {
      answers.push({ id: p.id, answer: '完全不相干的回答' });
      answers.push({ id: p.id, answer: '完全不相干的回答' });
      answers.push({ id: p.id, answer: '完全不相干的回答' });
    }
    const card = await scoreProbeAnswers(env as never, answers);
    expect(card.hits).toBe(0);
    expect(card.total).toBe(10);
  });

  it('两发一过一不过 → 过（过半数）', async () => {
    const { scoreProbeAnswers } = await import('./probe-eval');
    const env = {
      KV: { put: async function () { return undefined; } },
      DB: { prepare: function () { return { bind: function () { return { run: async function () { return { meta: { changes: 1 } }; } }; } }; } },
    };
    const answers = [
      { id: 'video_end', answer: '结尾是「因为我们是朋友」' },
      { id: 'video_end', answer: '不记得了' },
    ];
    const card = await scoreProbeAnswers(env as never, answers);
    const hit = card.results.find(function (r) { return r.id === 'video_end'; });
    expect(hit?.hit).toBe(true);
  });
});
