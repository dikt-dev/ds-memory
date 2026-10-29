import { describe, expect, it } from 'vitest';
import { compactHistoryMessage, sanitizeMessagePlaceholders } from './db';

describe('sanitizeMessagePlaceholders', () => {
  it('把各类 R2 路径压成标记', () => {
    const input = [
      '[图片:images/2026-10-28/1699999999999.jpg]',
      '[视频:videos/2026-10-28/1c2f8a2e-1111-2222-3333-444455556666.mp4]',
      '[GIF:gifs/2026-10-28/abc.gif]',
      '[语音:audio/2026-10-28/xyz.mp3]',
    ].join('\n');
    expect(sanitizeMessagePlaceholders(input)).toBe('[图片]\n[视频]\n[GIF]\n[语音]');
  });

  it('去掉静默标记与资料块正文', () => {
    expect(sanitizeMessagePlaceholders('晚安[END]')).toBe('晚安');
    expect(sanitizeMessagePlaceholders('[BILI_META]一大堆字幕[/BILI_META]看完了')).toBe('[B站资料]看完了');
    expect(sanitizeMessagePlaceholders('[WEB_META]正文[/WEB_META]')).toBe('[网页资料]');
  });

  it('普通文本原样保留', () => {
    expect(sanitizeMessagePlaceholders('今天去西湖了')).toBe('今天去西湖了');
  });
});

describe('compactHistoryMessage', () => {
  it('视频占位符不再残留 UUID', () => {
    const out = compactHistoryMessage('看这个\n[视频:videos/2026-10-28/1c2f8a2e-1111-2222-3333-444455556666.mp4]');
    expect(out).toBe('看这个 [视频]');
    expect(out).not.toContain('1c2f8a2e');
  });

  it('仍然压缩空白并截断长文本', () => {
    expect(compactHistoryMessage('a\n\n\n b')).toBe('a b');
    const long = 'x'.repeat(3000);
    const out = compactHistoryMessage(long, 100);
    expect(out.length).toBeLessThanOrEqual(101);
    expect(out).toContain('…');
  });
});
