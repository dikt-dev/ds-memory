import { describe, expect, it } from 'vitest';
import { replaceFaceMarkers, faceToEmoji } from './faces';

describe('表情标记', () => {
  it('协议写法转 emoji', () => {
    expect(replaceFaceMarkers('好耶[face:敲打]')).toBe('好耶🔨');
    expect(replaceFaceMarkers('[face:害羞]')).toBe('☺️');
  });

  it('直接写表情名也转（线上漏网的那种）', () => {
    expect(replaceFaceMarkers('谁让你强行解压了 [敲打]')).toBe('谁让你强行解压了 🔨');
    expect(replaceFaceMarkers('[捂脸]')).toBe('🤦');
  });

  it('数字表情', () => {
    expect(faceToEmoji('14')).toBe('🙂');
    expect(replaceFaceMarkers('[face:37]')).toBe('🔨');
  });

  it('协议标记和普通括号不动', () => {
    expect(replaceFaceMarkers('[语音]晚安')).toBe('[语音]晚安');
    expect(replaceFaceMarkers('笔记[重要] 别忘了')).toBe('笔记[重要] 别忘了');
    expect(replaceFaceMarkers('[图片:images/2026-11-05/a.jpg]')).toBe('[图片:images/2026-11-05/a.jpg]');
  });

  it('认不出的 [face:名] 直接删掉，不漏成可见文本', () => {
    expect(replaceFaceMarkers('好的[face:不存在的表情]')).toBe('好的');
  });

  it('多个混排', () => {
    expect(replaceFaceMarkers('[face:害羞][敲打][face:14]')).toBe('☺️🔨🙂');
  });
});
