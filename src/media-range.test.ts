import { describe, expect, it } from 'vitest';
import { parseByteRange } from './media';

describe('parseByteRange', () => {
  it('没有 Range 头时返回 null（整段返回）', () => {
    expect(parseByteRange(undefined, 100)).toBeNull();
    expect(parseByteRange(null, 100)).toBeNull();
    expect(parseByteRange('', 100)).toBeNull();
  });

  it('解析闭区间', () => {
    expect(parseByteRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 });
    expect(parseByteRange('bytes=100-199', 1000)).toEqual({ start: 100, end: 199 });
  });

  it('省略 end 时取到文件末尾', () => {
    expect(parseByteRange('bytes=500-', 1000)).toEqual({ start: 500, end: 999 });
  });

  it('bytes=-N 取末尾 N 字节', () => {
    expect(parseByteRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 });
    expect(parseByteRange('bytes=-5000', 1000)).toEqual({ start: 0, end: 999 });
  });

  it('end 超出文件大小时截断', () => {
    expect(parseByteRange('bytes=900-9999', 1000)).toEqual({ start: 900, end: 999 });
  });

  it('非法输入返回 invalid', () => {
    expect(parseByteRange('bytes=abc', 1000)).toBe('invalid');
    expect(parseByteRange('items=0-10', 1000)).toBe('invalid');
    expect(parseByteRange('bytes=-', 1000)).toBe('invalid');
    expect(parseByteRange('bytes=200-100', 1000)).toBe('invalid');
    expect(parseByteRange('bytes=1000-', 1000)).toBe('invalid');
    expect(parseByteRange('bytes=0-1,5-6', 1000)).toBe('invalid');
    expect(parseByteRange('bytes=0-10', 0)).toBe('invalid');
  });
});
