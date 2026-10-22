import { describe, expect, it } from 'vitest';
import { countMemoryEntries, daysBetween, detectMilestones } from './milestone';

describe('daysBetween', () => {
  it('计算天数差', () => {
    expect(daysBetween('2026-10-01', '2026-10-22')).toBe(21);
    expect(daysBetween('2026-01-01', '2026-12-31')).toBe(364);
    expect(daysBetween('2026-10-22', '2026-10-22')).toBe(0);
  });
});

describe('detectMilestones', () => {
  const base = { firstChatDate: '2026-10-01', today: '2026-10-22', streakDays: 3, memoryEntryCount: 20 };

  it('普通日子没有里程碑', () => {
    expect(detectMilestones(base)).toEqual([]);
  });

  it('认识第 100 天', () => {
    const m = detectMilestones({ ...base, today: '2027-01-09' }); // 100 天后
    expect(m.length).toBe(1);
    expect(m[0].kind).toBe('anniversary');
    expect(m[0].topic).toContain('100');
  });

  it('认识满一年权重更高', () => {
    const m = detectMilestones({ ...base, today: '2027-10-01' }); // 365 天
    expect(m[0].topic).toContain('365');
    expect(m[0].weight).toBe(40);
  });

  it('连续聊天天数里程碑', () => {
    const m = detectMilestones({ ...base, streakDays: 30 });
    expect(m.some((x) => x.kind === 'streak')).toBe(true);
    expect(m.find((x) => x.kind === 'streak')!.topic).toContain('30');
  });

  it('记忆条目数里程碑（50 的倍数）', () => {
    const m = detectMilestones({ ...base, memoryEntryCount: 50 });
    expect(m.some((x) => x.kind === 'count')).toBe(true);
  });

  it('没有首次对话日期时跳过周年', () => {
    const m = detectMilestones({ ...base, firstChatDate: null, today: '2027-01-09' });
    expect(m.every((x) => x.kind !== 'anniversary')).toBe(true);
  });
});

describe('countMemoryEntries', () => {
  it('统计带日期的条目', () => {
    const mem = `## 关于用户
- [2026-10-21] 事实A
- [2026-10-21] 事实B
## 偏好
- [2026-10-20] 偏好C
<!-- - [YYYY-MM-DD] 注释里的不算 -->
`;
    expect(countMemoryEntries(mem)).toBe(3);
  });

  it('空文本返回 0', () => {
    expect(countMemoryEntries('')).toBe(0);
  });
});
