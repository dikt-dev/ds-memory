import { describe, expect, it } from 'vitest';
import { parsePromises, pendingPromises, promisesBlock } from './memory-promises';

const memory = [
  '## 进行中的事',
  '- [26-11-07] 他在弄聊天 app',
  '## 答应过的事',
  '- [26-11-07] 答应他：剥十只虾换亲脸颊（未完成）',
  '- [26-11-06] 他答应：周末陪我打游戏（已完成）',
  '- [26-11-05] 答应他：别再叫他"大肥鱼"（未完成）',
  '## 共同经历',
  '- [26-11-06] 一起看二创',
].join('\n');

describe('承诺解析', () => {
  it('只解析「答应过的事」分区', () => {
    const all = parsePromises(memory);
    expect(all.length).toBe(3);
    expect(all[0].text).toContain('剥十只虾');
  });

  it('只取未完成的，按日期从新到旧', () => {
    const pending = pendingPromises(memory);
    expect(pending.length).toBe(2);
    expect(pending[0].date).toBe('26-11-07');
    expect(pending.some((p) => p.text.includes('打游戏'))).toBe(false);
  });

  it('注入文案带「还没做完的约定」', () => {
    const block = promisesBlock(memory);
    expect(block).toContain('还没做完的约定');
    expect(block).toContain('剥十只虾');
  });

  it('没有承诺分区时返回空', () => {
    expect(promisesBlock('## 关于他\n- [26-11-07] 他在深圳')).toBe('');
  });
});
