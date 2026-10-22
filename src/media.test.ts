import { describe, expect, it } from 'vitest';
import {
  IMAGE_QUALITY,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_SIDE,
  buildImageKey,
  compressImageBytes,
  parseDataUrl,
} from './media';

// 1x1 透明 PNG
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

describe('parseDataUrl', () => {
  it('解析 png data URL', () => {
    const r = parseDataUrl(`data:image/png;base64,${PNG_B64}`);
    expect(r?.mime).toBe('image/png');
    expect(r?.ext).toBe('png');
    expect(r?.bytes.length).toBeGreaterThan(0);
  });

  it('jpeg/webp/gif 扩展名映射', () => {
    expect(parseDataUrl(`data:image/jpeg;base64,${PNG_B64}`)?.ext).toBe('jpg');
    expect(parseDataUrl(`data:image/webp;base64,${PNG_B64}`)?.ext).toBe('webp');
    expect(parseDataUrl(`data:image/gif;base64,${PNG_B64}`)?.ext).toBe('gif');
  });

  it('非法输入返回 null', () => {
    expect(parseDataUrl('hello')).toBeNull();
    expect(parseDataUrl('data:text/plain;base64,aGVsbG8=')).toBeNull();
    expect(parseDataUrl('data:image/png;base64,')).toBeNull();
    expect(parseDataUrl('data:image/svg+xml;base64,PHN2Zz4=')).toBeNull();
  });

  it('大小上限 8MB', () => {
    expect(MAX_IMAGE_BYTES).toBe(8 * 1024 * 1024);
  });
});

describe('buildImageKey', () => {
  it('按日期目录 + 时间戳命名', () => {
    expect(buildImageKey('2026-10-22', 1792630016123, 'jpg')).toBe('images/2026-10-22/1792630016123.jpg');
  });
});

describe('compressImageBytes', () => {
  it('PNG 转成 JPEG（输出 FFD8 开头）', () => {
    const parsed = parseDataUrl(`data:image/png;base64,${PNG_B64}`);
    expect(parsed).not.toBeNull();
    const out = compressImageBytes(parsed!.bytes, 'image/png');
    expect(out).not.toBeNull();
    expect(out!.mime).toBe('image/jpeg');
    expect(out!.ext).toBe('jpg');
    expect(out!.bytes[0]).toBe(0xff);
    expect(out!.bytes[1]).toBe(0xd8);
  });

  it('小 JPEG 跳过压缩（返回 null 表示用原图）', () => {
    const parsed = parseDataUrl(`data:image/jpeg;base64,${PNG_B64}`);
    const out = compressImageBytes(parsed!.bytes, 'image/jpeg');
    expect(out).toBeNull();
  });

  it('压缩参数', () => {
    expect(MAX_IMAGE_SIDE).toBe(1024);
    expect(IMAGE_QUALITY).toBe(0.7);
  });
});
