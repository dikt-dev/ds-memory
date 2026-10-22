import { describe, expect, it } from 'vitest';
import { analyzeMood, moodLabelText, moodScoreAdjust, moodToneHint } from './mood';

describe('analyzeMood', () => {
  it('空文本返回中性', () => {
    const r = analyzeMood('');
    expect(r.mood).toBe('neutral');
    expect(r.suggestContact).toBe(true);
  });

  it('识别低落情绪', () => {
    const r = analyzeMood('今天好难过，想哭，感觉特别孤独');
    expect(r.mood).toBe('low');
    expect(r.valence).toBeLessThan(0);
    expect(r.suggestContact).toBe(true); // 低落时更需要陪伴
    expect(r.signals.length).toBeGreaterThan(0);
  });

  it('识别疲惫', () => {
    const r = analyzeMood('好累啊，天天熬夜加班，撑不住了');
    expect(['tired', 'low']).toContain(r.mood);
    expect(r.suggestContact).toBe(false); // 太累别打扰
  });

  it('识别忙碌', () => {
    const r = analyzeMood('在忙，赶 ddl，开会中，稍后说');
    expect(r.mood).toBe('busy');
    expect(r.suggestContact).toBe(false);
  });

  it('识别开心', () => {
    const r = analyzeMood('哈哈太好了，项目通过了，超开心');
    expect(r.mood).toBe('happy');
    expect(r.valence).toBeGreaterThan(0);
    expect(r.suggestContact).toBe(true);
  });

  it('普通对话返回中性（弱正面词不足以判定开心）', () => {
    const r = analyzeMood('今天天气不错，中午吃了面');
    expect(r.mood).toBe('neutral');
    expect(r.intensity).toBeLessThan(0.2); // 有微弱信号但不构成情绪
  });

  it('单个弱正面词不算开心', () => {
    expect(analyzeMood('这家店不错').mood).toBe('neutral');
  });

  it('多个弱正面词或强词才算开心', () => {
    expect(analyzeMood('今天挺开心，也很高兴').mood).toBe('happy');
    expect(analyzeMood('搞定了！').mood).toBe('happy');
  });
});

describe('moodScoreAdjust', () => {
  it('忙碌时大幅减分', () => {
    const adj = moodScoreAdjust(analyzeMood('在忙，稍后说'));
    expect(adj.delta).toBeLessThan(0);
    expect(adj.reason).toContain('不宜打扰');
  });

  it('低落时加分', () => {
    const adj = moodScoreAdjust(analyzeMood('好难过，想哭，特别孤独'));
    expect(adj.delta).toBeGreaterThan(0);
    expect(adj.reason).toContain('陪伴');
  });

  it('中性时不影响', () => {
    expect(moodScoreAdjust(analyzeMood('今天吃了面')).delta).toBe(0);
  });
});

describe('moodLabelText / moodToneHint', () => {
  it('标签文案', () => {
    expect(moodLabelText('low')).toBe('情绪低落');
    expect(moodLabelText('busy')).toBe('忙碌');
  });

  it('语气提示', () => {
    expect(moodToneHint(analyzeMood('好难过，想哭'))).toContain('语气要轻');
    expect(moodToneHint(analyzeMood('今天吃了面'))).toBe('');
  });
});
