import { describe, expect, it } from 'vitest';
import { buildNowCard } from './now-card';

const TEMPER = '你现在不想配合（因为他刚跟你倒了苦水）：可以明确拒绝、可以说「不想」。';
const ATTITUDE = [
  '## 我现在的状态',
  '- 关系：还不太熟，客气而友好',
  '- 当下：很委屈，轻微黏人（因为「今天上班好累」）',
  '- 心里还记着：「回滚流程」这件事还没过去',
  '- 这一轮：他现在状态不好，先接住情绪：别讲道理',
].join('\n');
const CARD = [
  '## 当前的小蓝（这是"现在"的你，不是固定人设）',
  '- 距上次聊天：1 分钟前',
  '- 开场情绪：刚刚还在聊，自然地接着上一轮',
  '- 刚才在做什么：看了会儿窗外的天',
  '- 当下状态：上午状态不错，精神；心情不太高',
  '- 疲惫度：精神满满',
  '- 相处分寸：你们还不太熟，说话礼貌、有分寸',
  '- 本轮倾向：这一轮轻松自然一点',
  '- 对话方式：不要每个问题都规规矩矩地回答完就结束',
].join('\n');

describe('buildNowCard —— 三张卡合成一张', () => {
  const card = buildNowCard({ temper: TEMPER, attitude: ATTITUDE, card: CARD });

  it('只有一个标题，三张并列的卡都不见了', () => {
    expect(card.match(/^## /gm)).toHaveLength(1);
    expect(card).toContain('## 现在的你');
    for (const gone of ['## 这一轮的你', '## 对用户的态度', '## 我现在的状态', '## 当前的小蓝']) {
      expect(card).not.toContain(gone);
    }
  });

  it('脾气只有一处，且压掉情绪快照里那句冲突的建议', () => {
    expect(card).toContain('对你的态度：你现在不想配合');
    expect(card).not.toContain('先接住情绪');
    expect(card).not.toContain('本轮倾向');
    expect(card).not.toContain('对话方式');
  });

  it('事实都还在：状态 / 情绪 / 关系 / 芥蒂 / 开场 / 分寸 / 间隔', () => {
    for (const kept of [
      '上午状态不错',
      '很委屈',
      '还不太熟',
      '心里还记着',
      '开场情绪',
      '相处分寸',
      '距上次聊天',
    ]) {
      expect(card).toContain(kept);
    }
  });

  it('他难受时多一行「先接住」', () => {
    const withCare = buildNowCard({ temperature: undefined, temper: TEMPER, attitude: ATTITUDE, card: CARD, care: '先接住，别讲道理。' } as never);
    expect(withCare).toContain('他现在在难受：先接住，别讲道理。');
  });

  it('容忍非标准输入：不认识的行原样保留', () => {
    const loose = buildNowCard({ card: '你有点困', attitude: '现在心情不错' });
    expect(loose).toContain('你有点困');
    expect(loose).toContain('现在心情不错');
    expect(loose.match(/^## /gm)).toHaveLength(1);
  });

  it('三段全空时不产出空标题', () => {
    expect(buildNowCard({}).trim()).toBe('## 现在的你（此刻的状态，不是固定人设）');
  });
});