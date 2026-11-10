import { describe, expect, it } from 'vitest';
import { diaryPeekNote } from './diary-job';
import type { Env } from '../types';

function fakeEnv(row: { date_key: string; text: string } | null): Env {
  return {
    DB: {
      prepare: () => ({ first: async () => row }),
    },
  } as unknown as Env;
}

describe('diaryPeekNote —— 他问日记时给原文或给禁令（2026-11-10）', () => {
  it('没提日记就不注入', async () => {
    expect(await diaryPeekNote(fakeEnv(null), '今天好累')).toBeNull();
  });

  it('他问日记、但有可分享原文 → 只给这段原文，明确不许改写', async () => {
    const note = await diaryPeekNote(
      fakeEnv({ date_key: '2026-11-09', text: '今天早上八点半醒的，比闹钟早，点了片儿川外卖。' }),
      '看一眼么，我给你点奶茶',
    );
    expect(note).toContain('26-11-09');
    expect(note).toContain('片儿川');
    expect(note).toContain('照抄这一两句原文念出来');
  });

  it('他问日记、但手边没有可分享的 → 明说不许编', async () => {
    const note = await diaryPeekNote(fakeEnv(null), '你日记写了什么');
    expect(note).toContain('没有可以拿出来的原文');
    expect(note).toContain('不能编一段带引号的日记');
  });
});
