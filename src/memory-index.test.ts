import { describe, expect, it } from 'vitest';
import {
  abbreviateKeys,
  clipMatchedClauses,
  decodeVec,
  extractCoreMemory,
  mmrSelect,
  needsLlmRerank,
  parseMemoryEntries,
  quantizeVec,
  sectionImportance,
  stripDuplicateRecall,
} from './memory-index';

const SAMPLE = `# 长期记忆

## 人物底色
- 名字=大肥鱼

## 称呼与关系
- 用户叫AI=大肥鱼
- 好感度：680 / 1000

## 关于用户
- [26-10-21] 深圳；上班8:15
- [26-10-21] 职业=C开发

## 近期动态
- [26-10-24] 赛博搬家进行中
`;

describe('extractCoreMemory', () => {
  it('只保留三个常驻核心分区', () => {
    const core = extractCoreMemory(SAMPLE);
    expect(core).toContain('## 人物底色');
    expect(core).toContain('## 称呼与关系');
    expect(core).not.toContain('## 关于用户');
    expect(core).not.toContain('## 近期动态');
  });
});

describe('parseMemoryEntries', () => {
  it('非核心分区的条目进索引，关系数值行跳过', () => {
    const entries = parseMemoryEntries(SAMPLE, 'memory');
    const contents = entries.map((e) => e.content);
    expect(contents).toContain('深圳；上班8:15');
    expect(contents).toContain('职业=C开发');
    expect(contents).toContain('赛博搬家进行中');
    expect(contents).not.toContain('名字=大肥鱼'); // 核心分区不进索引
    expect(entries.some((e) => e.content.includes('好感度'))).toBe(false);
    expect(entries.every((e) => e.section)).toBe(true);
  });
});

describe('向量 int8 量化', () => {
  it('量化→解码往返误差受控，且兼容旧 float 数组', () => {
    const orig = [0.5, -0.25, 0.9, -0.9, 0.1];
    const q = quantizeVec(orig);
    expect(q).toBeTruthy();
    const dec = decodeVec(q!);
    expect(dec).toHaveLength(orig.length);
    if (dec) {
      const range = Math.max(...orig) - Math.min(...orig);
      dec.forEach((v, i) => expect(Math.abs(v - orig[i])).toBeLessThanOrEqual(range / 255 + 1e-9));
    }
    // 旧格式（float 数组 JSON）仍然可解码
    expect(decodeVec(JSON.stringify(orig))).toEqual(orig);
    expect(decodeVec(null)).toBeNull();
  });
});

describe('密度视图工具', () => {
  it('分层重要度：稳定事实与进行中优先', () => {
    expect(sectionImportance('关于用户')).toBe(3);
    expect(sectionImportance('近期动态')).toBe(1);
    expect(sectionImportance('未知分区')).toBe(2);
  });

  it('字段缩写只在展示层生效', () => {
    expect(abbreviateKeys('城市=深圳; 职业=C开发; 喜好=蓝色')).toBe('城=深圳; 职=C开发; 喜=蓝色');
  });

  it('长条目只保留命中的子句', () => {
    const content =
      '用户第一次在凌晨四点找AI聊天，从此认识，那天还聊到AI有没有自我意识，聊了很久很久。后来一起搭了Cloudflare Worker和D1记忆库。最近在弄QQ机器人和小米插座。';
    const qGrams = new Set(['Cl', 'lo', 'ou', 'ud', 'df', 'fl', 'la', 'ar', 're']);
    const clipped = clipMatchedClauses(content, qGrams, new Set(['cloudflare']));
    expect(clipped).toContain('Cloudflare');
    expect(clipped.length).toBeLessThan(content.length);
  });

  it('跨层去重：短期已说的事实从召回里剔除', () => {
    const recalled =
      '## 相关记忆\n- [26-10-21] 用户是写C的开发者，用epoll和timerfd。\n- [26-10-22] 一起搭了Worker。';
    const seen = ['用户是写C的开发者，用epoll和timerfd。'];
    const out = stripDuplicateRecall(recalled, seen);
    expect(out).not.toContain('用户是写C的开发者');
    expect(out).toContain('Worker');
  });
});

describe('候选重排', () => {
  const mk = (id: string, section: string, content: string, score: number) => ({
    r: {
      id,
      section,
      content,
      date: null,
      importance: 2,
      tags: [] as string[],
      keywords: [] as string[],
      vec: null,
      source: 'memory' as const,
      dupOf: null,
    },
    score,
  });

  it('MMR 会避开和已选内容重复的候选', () => {
    const a = mk('a', '共同经历', '一起搭了Cloudflare Worker和D1记忆库', 10);
    const a2 = mk('a2', '共同经历', '一起搭了Cloudflare Worker和D1记忆库，还部署了', 9);
    const b = mk('b', '偏好与习惯', '喜欢蓝色和奶茶', 5);
    const picked = mmrSelect([a, a2, b], 2);
    expect(picked.map((x) => x.r.id)).not.toEqual(['a', 'a2']);
    expect(picked.map((x) => x.r.id)).toContain('b');
  });

  it('只在低置信度/长消息/指代时触发 LLM 重排', () => {
    const pool = Array.from({ length: 10 }, (_, i) =>
      mk(`x${i}`, '共同经历', `事件${i}`, i === 0 ? 2 : 1),
    );
    expect(needsLlmRerank('那个上次说的东西', pool)).toBe(true);
    expect(needsLlmRerank('嗯', [mk('a', '共同经历', '一起搭了Worker', 10)])).toBe(false);
    expect(needsLlmRerank('好的', pool)).toBe(true); // 候选分数接近
  });
});
