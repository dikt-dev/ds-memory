
import { describe, expect, it } from 'vitest';
import { isMemoryQuestion, memoryAnswerHint } from './query-expand';

describe('记忆题识别', () => {
  it('记忆题命中', () => {
    for (const q of ['你还记得那个二创视频吗', '我上次发的那个视频', '你答应过我什么', '我叫你什么外号', '砂锅粥哪家']) {
      expect(isMemoryQuestion(q)).toBe(true);
    }
  });
  it('普通闲聊不命中', () => {
    for (const q of ['今天天气怎么样', '在干嘛', '哈哈哈']) {
      expect(isMemoryQuestion(q)).toBe(false);
    }
  });
  it('有召回和没召回给的要求不同', () => {
    expect(memoryAnswerHint(true)).toContain('先直接回答');
    expect(memoryAnswerHint(false)).toContain('记不清');
  });
});
