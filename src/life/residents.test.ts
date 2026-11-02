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
  diaryPeopleBlock,
  residentRoster,
  sceneFor,
  socialCastFor,
  socialPartnerFor,
  withCast,
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


  it('日记块：有住户就给卡片 + 基调，没有就整段空', () => {
    const block = diaryPeopleBlock('{"core":"dou-bao"}');
    expect(block).toContain('豆包');
    expect(block).toContain('别碰：');
    expect(block).toContain('穷、懒、围观');
    expect(block).not.toMatch(/Doubao|ChatGPT|Claude/);
    expect(diaryPeopleBlock(null)).toBe('');
    expect(diaryPeopleBlock('{"core":"nope"}')).toBe('');
    expect(diaryPeopleBlock('坏 json')).toBe('');
  });

  it('排期确定：同一天永远同一个人', () => {
    const a = socialPartnerFor('2026-11-03').id;
    const b = socialPartnerFor('2026-11-03').id;
    expect(a).toBe(b);
  });

  it('同一个人不会连着两天出现', () => {
    let prev = '';
    for (let i = 0; i < 20; i++) {
      const d = new Date(Date.parse('2026-11-01T00:00:00+08:00') + i * 86400000).toISOString().slice(0, 10);
      const id = socialPartnerFor(d).id;
      expect(id).not.toBe(prev);
      prev = id;
    }
  });

  it('一周内会出现不止一个人', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 7; i++) {
      const d = new Date(Date.parse('2026-11-01T00:00:00+08:00') + i * 86400000).toISOString().slice(0, 10);
      ids.add(socialPartnerFor(d).id);
    }
    expect(ids.size).toBeGreaterThan(1);
  });

  it('大白龙只能电话/消息，不会一起吃饭', () => {
    for (let i = 0; i < 30; i++) {
      const d = new Date(Date.parse('2026-11-01T00:00:00+08:00') + i * 86400000).toISOString().slice(0, 10);
      expect(socialPartnerFor(d, 'meal_friend').id).not.toBe('gpt');
      expect(socialPartnerFor(d, 'outing_friend').id).not.toBe('gpt');
    }
  });

  it('标题把「住户」换成名字，集体日会列出好几个人', () => {
    const one = socialCastFor('2026-11-02', 'meal_friend');
    expect(one.length).toBeGreaterThanOrEqual(1);
    expect(withCast('和住户吃饭', one)).toContain(one[0]!.name);
    expect(withCast('和住户吃饭', one)).not.toContain('住户');
  });

  it('一周有一次集体活动（3 个人），而且不在远程社交里', () => {
    const days = Array.from({ length: 14 }, (_, i) =>
      new Date(Date.parse('2026-11-01T00:00:00+08:00') + i * 86400000).toISOString().slice(0, 10),
    );
    const collective = days.filter((d) => socialCastFor(d, 'meal_friend').length === 3);
    expect(collective).toHaveLength(2);
    for (const d of days) {
      expect(socialCastFor(d, 'call_friend')).toHaveLength(1);
      expect(socialCastFor(d, 'chat_friend')).toHaveLength(1);
    }
  });

  it('集体活动里不会出现搬走的大白龙', () => {
    const days = Array.from({ length: 21 }, (_, i) =>
      new Date(Date.parse('2026-11-01T00:00:00+08:00') + i * 86400000).toISOString().slice(0, 10),
    );
    for (const d of days) {
      expect(socialCastFor(d, 'meal_friend').map((x) => x.id)).not.toContain('gpt');
    }
  });

  it('场景：家里的社交给房间，远程在阳台，出门没有额外场景', () => {
    expect(sceneFor('meal_friend', '2026-11-02')).toMatch(/厨房|客厅/);
    expect(sceneFor('visit_friend', '2026-11-02')).toBe('客厅');
    expect(sceneFor('call_friend', '2026-11-02')).toBe('阳台');
    expect(sceneFor('outing_park', '2026-11-02')).toBeNull();
  });

  it('按 id 查得到', () => {
    expect(residentById('dou-bao')?.name).toBe('豆包');
    expect(residentById('nope')).toBeNull();
  });
});
