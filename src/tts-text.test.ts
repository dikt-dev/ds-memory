import { describe, expect, it } from 'vitest';
import { cleanSpeechText } from './tts';

describe('cleanSpeechText —— 只有语音文本去括号', () => {
  it('动作/语气括号去掉，话留下', () => {
    const out = cleanSpeechText('（顿了一下）你自己说的啊。');
    expect(out).toBe('你自己说的啊。');
  });

  it('句中动作也去掉，别把句子切断', () => {
    const out = cleanSpeechText('行吧（把手机举远一点）我听着呢。');
    expect(out).toBe('行吧我听着呢。');
  });

  it('语气说明整段去掉', () => {
    expect(cleanSpeechText('好（语气软下来）你早点睡')).toBe('好你早点睡');
  });

  it('markdown 和标记也一起清', () => {
    expect(cleanSpeechText('**知道了** [face:微笑] 晚安')).toBe('知道了 晚安');
  });
});
