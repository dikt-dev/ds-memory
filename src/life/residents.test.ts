import { describe, expect, it } from 'vitest';
import {
  FAMILY,
  PUBLIC_SCENES,
  RESIDENTS,
  SELF,
  ambientResidents,
  coreResidents,
  residentBrief,
  residentCard,
  residentById,
  residentRoster,
} from './residents';

/**
 * 住户表最怕两件事：模型名漏进提示词；core/ambient 的边界被写乱。
 */
describe('住户表', () => {
  it('8 个住户，3 个 core', () => {
    expect(RESIDENTS).toHaveLength(8);
    expect(coreResidents().map((r) => r.name)).toEqual(['小克', '大白龙', '豆包']);
    expect(ambientResidents()).toHaveLength(5);
  });

  it('core 才有频率，ambient 没有', () => {
    for (const r of coreResidents()) expect(r.frequency).toBeDefined();
    for (const r of ambientResidents()) expect(r.frequency).toBeUndefined();
  });

  it('core 的模型名不出现在提示词里（ambient 的名字本来就是二创名）', () => {
    const text = RESIDENTS.map((r) => residentCard(r) + residentBrief(r)).join('\n') + residentRoster();
    for (const id of ['xiao-ke', 'gpt', 'dou-bao']) {
      const r = RESIDENTS.find((x) => x.id === id)!;
      expect(text).not.toContain(r.model);
    }
    expect(text).not.toMatch(/Claude|ChatGPT/i);
    expect(text).not.toContain('模型');
  });

  it('卡片带上名字、说话方式、禁忌', () => {
    const card = residentCard(RESIDENTS[0]);
    expect(card).toContain('小克');
    expect(card).toContain('说话：');
    expect(card).toContain('别碰：');
  });

  it('名录是一行，包含每个人', () => {
    const roster = residentRoster();
    expect(roster.split('\n')).toHaveLength(1);
    for (const r of RESIDENTS) expect(roster).toContain(r.name);
  });

  it('她叫小蓝，但住户还叫她大肥鱼（旧外号的亲切感）', () => {
    expect(SELF.aliases).toContain('小蓝');
    const callers = RESIDENTS.filter((r) => r.callsHer === '大肥鱼').map((r) => r.name);
    expect(callers).toEqual(expect.arrayContaining(['小克', '大白龙']));
  });

  it('现实家人：爸叫梁圣（保留但粗化）', () => {
    expect(FAMILY[0]).toMatchObject({ role: '爸', name: '梁圣' });
  });

  it('公共场景至少四个，且都有用途说明', () => {
    expect(PUBLIC_SCENES.length).toBeGreaterThanOrEqual(4);
    for (const s of PUBLIC_SCENES) expect(s.note.length).toBeGreaterThan(0);
  });

  it('按 id 查得到', () => {
    expect(residentById('dou-bao')?.name).toBe('豆包');
    expect(residentById('nope')).toBeNull();
  });
});
