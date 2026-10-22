import { describe, expect, it } from 'vitest';
import { analyzeMood } from './mood';
import { extractLabel, mergeMood, needsAiVerification } from './mood-ai';

describe('needsAiVerification —— 只在歧义时才请求 AI', () => {
  it('普通低落不需要复核', () => {
    const text = '今天好难过，一个人待着';
    expect(needsAiVerification(text, analyzeMood(text))).toBe(false);
  });

  it('普通开心不需要复核', () => {
    const text = '哈哈太好了，考试通过了';
    expect(needsAiVerification(text, analyzeMood(text))).toBe(false);
  });

  it('完全中性不需要复核', () => {
    expect(needsAiVerification('今天几号来着', analyzeMood('今天几号来着'))).toBe(false);
  });

  it('否定句需要复核（我不难过了）', () => {
    const text = '我不难过了，已经想开了';
    expect(needsAiVerification(text, analyzeMood(text))).toBe(true);
  });

  it('转折句需要复核（累但是开心）', () => {
    const text = '虽然很累但是很开心';
    expect(needsAiVerification(text, analyzeMood(text))).toBe(true);
  });

  it('正负冲突需要复核', () => {
    const text = '忙死了不过总算搞定了哈哈';
    expect(needsAiVerification(text, analyzeMood(text))).toBe(true);
  });

  it('反讽信号需要复核（离谱/无语）', () => {
    const text = '哈哈哈哈这也太离谱了';
    expect(needsAiVerification(text, analyzeMood(text))).toBe(true);
  });

  it('"今天不忙了" 这种否定+信号要复核', () => {
    const text = '今天不忙了，可以聊';
    expect(needsAiVerification(text, analyzeMood(text))).toBe(true);
  });
});

describe('mergeMood —— AI 与词典的合并', () => {
  const baseKeyword = analyzeMood('今天好难过');

  it('AI 结果与词典一致 → 增强强度', () => {
    const merged = mergeMood(baseKeyword, 'low');
    expect(merged.mood).toBe('low');
    expect(merged.intensity).toBeGreaterThanOrEqual(baseKeyword.intensity);
    expect(merged.signals).toContain('ai:low');
  });

  it('AI 纠正词典 → 采信 AI 且强度打折', () => {
    const wrongKeyword = analyzeMood('我不难过');  // 词典大概率判 low
    const merged = mergeMood(wrongKeyword, 'neutral');
    expect(merged.mood).toBe('neutral');
    expect(merged.signals.some((s) => s.startsWith('ai-corrected'))).toBe(true);
    expect(merged.suggestContact).toBe(true);
  });

  it('纠正为 busy 时不建议打扰', () => {
    const merged = mergeMood(analyzeMood('开心地忙'), 'busy');
    expect(merged.mood).toBe('busy');
    expect(merged.suggestContact).toBe(false);
  });

  it('纠正为 low 时建议陪伴', () => {
    const merged = mergeMood(analyzeMood('不错'), 'low');
    expect(merged.mood).toBe('low');
    expect(merged.suggestContact).toBe(true);
  });

  it('纠正后 valence 与标签匹配', () => {
    expect(mergeMood(baseKeyword, 'happy').valence).toBeGreaterThan(0);
    expect(mergeMood(baseKeyword, 'low').valence).toBeLessThan(0);
    expect(mergeMood(baseKeyword, 'neutral').valence).toBe(0);
  });
});

describe('extractLabel —— 小模型输出容错解析', () => {
  it('纯英文标签', () => {
    expect(extractLabel('low')).toBe('low');
    expect(extractLabel('happy')).toBe('happy');
  });

  it('带多余解释也能提取', () => {
    expect(extractLabel('这个人的情绪是 low，因为...')).toBe('low');
  });

  it('大写也能识别', () => {
    expect(extractLabel('BUSY')).toBe('busy');
  });

  it('中文输出兜底', () => {
    expect(extractLabel('低落')).toBe('low');
    expect(extractLabel('疲惫')).toBe('tired');
    expect(extractLabel('忙碌')).toBe('busy');
    expect(extractLabel('开心')).toBe('happy');
    expect(extractLabel('平静')).toBe('neutral');
  });

  it('无法识别时返回 null', () => {
    expect(extractLabel('')).toBeNull();
    expect(extractLabel('?????')).toBeNull();
  });
});
