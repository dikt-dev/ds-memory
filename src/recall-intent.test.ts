import { describe, expect, it } from 'vitest';
import { parseSelection } from './recall-intent';

describe('parseSelection', () => {
  it('正常 JSON：意图与序号都解出来', () => {
    const r = parseSelection('{"intents":["学做饭","最近的打算"],"picks":[2,5]}', 8, 5);
    expect(r.intents).toEqual(['学做饭', '最近的打算']);
    expect(r.picks).toEqual([2, 5]);
  });

  it('容忍代码块与前后解释文字', () => {
    const text = '好的，结果如下：\n```json\n{"intents":["搬家"],"picks":[1]}\n```\n希望有帮助';
    expect(parseSelection(text, 5, 5).picks).toEqual([1]);
  });

  it('允许 picks 为空数组（宁缺毋滥）', () => {
    const r = parseSelection('{"intents":["随口聊天"],"picks":[]}', 6, 5);
    expect(r.picks).toEqual([]);
    expect(r.intents).toEqual(['随口聊天']);
  });

  it('越界序号丢弃、重复去重', () => {
    const r = parseSelection('{"intents":[],"picks":[0,1,1,9,3]}', 5, 5);
    expect(r.picks).toEqual([1, 3]);
  });

  it('不超过 maxPick', () => {
    const r = parseSelection('{"intents":[],"picks":[1,2,3,4,5,6,7]}', 10, 3);
    expect(r.picks).toEqual([1, 2, 3]);
  });

  it('序号是字符串也认', () => {
    const r = parseSelection('{"intents":[],"picks":["2","4"]}', 5, 5);
    expect(r.picks).toEqual([2, 4]);
  });

  it('intents 去空、限长、最多 4 条', () => {
    const long = '这是一条特别特别特别特别特别特别长的意图描述超过四十个字应该被丢掉'.repeat(2);
    const r = parseSelection(
      JSON.stringify({ intents: ['a', '  ', long, 'b', 'c', 'd', 'e'], picks: [] }),
      3,
      3,
    );
    expect(r.intents).toEqual(['a', 'b', 'c', 'd']);
  });

  it('不是 JSON / 完全跑偏时返回空（调用方回退确定性排序）', () => {
    expect(parseSelection('我觉得应该选第 2 条', 5, 5)).toEqual({ intents: [], picks: [] });
    expect(parseSelection('', 5, 5)).toEqual({ intents: [], picks: [] });
    expect(parseSelection('{"intents":', 5, 5)).toEqual({ intents: [], picks: [] });
  });

  it('支持 {index: n} 形式的 picks', () => {
    const r = parseSelection('{"intents":[],"picks":[{"index":3}]}', 5, 5);
    expect(r.picks).toEqual([3]);
  });
});
