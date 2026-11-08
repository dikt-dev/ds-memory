import { describe, expect, it } from 'vitest';
import { intentFactor, querySubjectBias, subjectFactor, rankMemoryChunks, type MemoryChunk } from './memory-domain';

const chunk = (id: string, content: string, subject: string | null): MemoryChunk => ({
  id,
  source: 'fact',
  sourceId: id,
  section: '关于他',
  content,
  date: '2026-11-07',
  keywords: ['项目'],
  tags: [],
  importance: 2,
  contentHash: id,
  updatedAt: 0,
  subject,
});

describe('querySubjectBias', () => {
  it('问「我」的事 → him', () => {
    expect(querySubjectBias('我那个项目卡在哪一步')).toBe('him');
  });
  it('问「你」的事 → her', () => {
    expect(querySubjectBias('你昨天怎么不高兴')).toBe('her');
  });
  it('我+你同时出现 → 不偏', () => {
    expect(querySubjectBias('我叫你什么外号')).toBe(null);
  });
  it('没有代词 → 不偏', () => {
    expect(querySubjectBias('今天天气怎么样')).toBe(null);
  });
});

describe('subjectFactor', () => {
  it('同主体加权，相反主体压一点，双方/空中性', () => {
    expect(subjectFactor('用户', 'him')).toBeGreaterThan(1);
    expect(subjectFactor('她', 'him')).toBeLessThan(1);
    expect(subjectFactor('双方', 'him')).toBe(1);
    expect(subjectFactor(null, 'him')).toBe(1);
    expect(subjectFactor('用户', null)).toBe(1);
  });
});

describe('rankMemoryChunks 按主体偏置', () => {
  it('关键词相同时，同主体的排在前面', () => {
    const chunks = [
      chunk('her', '项目整理得头大', '她'),
      chunk('him', '项目卡在转正自评', '用户'),
    ];
    const picked = rankMemoryChunks('我那个项目', chunks, 2, '', { subjectBias: 'him' });
    expect(picked[0].id).toBe('him');
  });

  it('不设偏置时顺序不受影响（保持原行为）', () => {
    const chunks = [
      chunk('a', '项目整理得头大', '她'),
      chunk('b', '项目卡在转正自评', '用户'),
    ];
    const picked = rankMemoryChunks('项目', chunks, 2);
    expect(picked.length).toBe(2);
  });
});

describe('intentFactor —— 问法和分区对齐', () => {
  it('问外号 → 称呼分区加权', () => {
    expect(intentFactor('我叫你什么外号', '称呼与关系')).toBeGreaterThan(1);
    expect(intentFactor('我叫你什么外号', '关于他')).toBe(1);
  });
  it('问情绪 → 近期动态加权', () => {
    expect(intentFactor('昨天为什么不高兴', '近期动态')).toBeGreaterThan(1);
    expect(intentFactor('昨天为什么不高兴', '关于他')).toBe(1);
  });
  it('无关问法不加权', () => {
    expect(intentFactor('今天吃什么', '近期动态')).toBe(1);
  });
});
