import { describe, expect, it } from 'vitest';
import { sanitizeDeepSeekMessages, type DeepSeekMessage } from './deepseek';

describe('sanitizeDeepSeekMessages', () => {
  it('删除落单代理字符，保留正常 emoji', () => {
    const messages: DeepSeekMessage[] = [
      { role: 'system', content: `系统\uD83D内容` },
      { role: 'user', content: '正常😀' },
      { role: 'assistant', content: `尾部\uDC00` },
    ];
    const out = sanitizeDeepSeekMessages(messages);
    expect(out[0].content).toBe('系统内容');
    expect(out[1].content).toBe('正常😀');
    expect(out[2].content).toBe('尾部');
  });

  it('处理多段 content 中的文本', () => {
    const messages: DeepSeekMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: `前面\uD800` },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } },
        ],
      },
    ];
    const out = sanitizeDeepSeekMessages(messages);
    expect(out[0].content).toEqual([
      { type: 'text', text: '前面' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } },
    ]);
  });
});
