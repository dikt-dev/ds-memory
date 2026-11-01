import { expect, it } from 'vitest';
import { DECLINE_COOLDOWN_MS } from './diary-api';

it('冷却期是 30 分钟（太短会被同一句话再拒一次）', () => {
  expect(DECLINE_COOLDOWN_MS).toBe(30 * 60 * 1000);
});
