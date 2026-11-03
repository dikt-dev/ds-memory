import { describe, expect, it } from 'vitest';
import { replyDelayMs } from './state';


describe('replyDelayMs（回复前等一会儿）', () => {
  it('闲着也要一两秒，不能是 0', () => {
    expect(replyDelayMs('free', () => 0)).toBeGreaterThanOrEqual(800);
    expect(replyDelayMs('free', () => 0.999)).toBeLessThanOrEqual(3300);
  });
  it('在忙比闲着慢很多', () => {
    const busy = replyDelayMs('busy', () => 0.5);
    expect(busy).toBeGreaterThan(replyDelayMs('free', () => 0.999));
    expect(busy).toBeLessThanOrEqual(18000);
  });
  it('睡着的时候最慢', () => {
    expect(replyDelayMs('sleeping', () => 0.5)).toBeGreaterThan(replyDelayMs('busy', () => 0.999));
    expect(replyDelayMs('sleeping', () => 0.999)).toBeLessThanOrEqual(60000);
  });
});
