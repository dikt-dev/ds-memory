import { describe, expect, it } from 'vitest';
import { spokenTime } from './date';

describe('spokenTime（北京时间口语读法）', () => {
  it('晚间：21:11 → 晚上九点十一分', () => {
    expect(spokenTime(new Date('2026-10-29T13:11:00Z'))).toBe('晚上九点十一分');
  });

  it('个位分钟补“零”：21:05 → 晚上九点零五分', () => {
    expect(spokenTime(new Date('2026-10-29T13:05:00Z'))).toBe('晚上九点零五分');
  });

  it('整点：21:00 → 晚上九点整', () => {
    expect(spokenTime(new Date('2026-10-29T13:00:00Z'))).toBe('晚上九点整');
  });

  it('正午：12:30 → 中午十二点三十分', () => {
    expect(spokenTime(new Date('2026-10-29T04:30:00Z'))).toBe('中午十二点三十分');
  });

  it('零点：00:10 → 凌晨零点十分', () => {
    expect(spokenTime(new Date('2026-10-28T16:10:00Z'))).toBe('凌晨零点十分');
  });
});
