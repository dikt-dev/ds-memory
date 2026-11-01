import { describe, expect, it } from 'vitest';
import { suspendStaleOngoing } from './memory-ongoing';

const text = [
  '## 进行中的事项',
  '- [26-10-20] [进行中] 早就该挂起了',
  '- [26-10-30] [进行中] 还新鲜',
  '- [26-10-01] [进行中] 用户要回上海（下月 20 号左右）',
  '- [26-10-01] [已完成] 已经完成的',
].join('\n');

describe('suspendStaleOngoing', () => {
  it('超过 7 天降级，未来日期和已完成豁免', () => {
    const { text: out, suspended } = suspendStaleOngoing(text, '2026-11-01', 7);
    expect(suspended).toHaveLength(1);
    expect(out).toContain('- [26-10-20] [挂起] 早就该挂起了');
    expect(out).toContain('- [26-10-30] [进行中] 还新鲜');
    expect(out).toContain('- [26-10-01] [进行中] 用户要回上海');
    expect(out).toContain('- [26-10-01] [已完成] 已经完成的');
  });
});
