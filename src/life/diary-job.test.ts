import { describe, expect, it } from 'vitest';
import { diarySucceeded } from './diary-job';

describe('diarySucceeded —— 日记任务的成功判定（2026-11-10）', () => {
  it('晚间已写过，保底补跑撞上 already-written：算成功', () => {
    expect(diarySucceeded({ ok: true, skipped: 'already-written' })).toBe(true);
  });

  it('正常写完：算成功', () => {
    expect(diarySucceeded({ ok: true })).toBe(true);
  });

  it('当天没素材（no-plan）：仍算失败，要人看', () => {
    expect(diarySucceeded({ ok: false, skipped: 'no-plan' })).toBe(false);
  });

  it('异常：算失败', () => {
    expect(diarySucceeded({ ok: false, skipped: 'exception' })).toBe(false);
  });
});
