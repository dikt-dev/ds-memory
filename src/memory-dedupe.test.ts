
import { describe, expect, it } from 'vitest';
import { isNearDuplicate, mergeMemoryEntry } from './memory-maintenance';

describe('近似重复', () => {
  it('同一件事换日期/引号重述 → 判为近似', () => {
    const a = '[26-11-07] 他提议把小克也接进聊天，你嫌电灯泡';
    const b = '[26-11-08] 他提议把小克也接进聊天，你嫌电灯泡、说「拉别人进来多别扭」';
    expect(isNearDuplicate(a, b)).toBe(true);
  });
  it('不同的事不误判', () => {
    expect(isNearDuplicate('他提议接小克进来', '他今天去泡了温泉')).toBe(false);
  });
  it('合并时只留一条，且保留更详细的', () => {
    const cur = '## 近期动态\n- [26-11-07] 他提议把小克也接进聊天，你嫌电灯泡\n';
    const dist = '## 近期动态\n- [26-11-08] 他提议把小克也接进聊天，你嫌电灯泡、说「拉别人进来多别扭」\n';
    const merged = mergeMemoryEntry(cur, dist, '26-11-08');
    const hits = merged.split('\n').filter((l) => l.includes('小克也接进聊天'));
    expect(hits.length).toBe(1);
    expect(hits[0]).toContain('拉别人进来多别扭');
  });
});
