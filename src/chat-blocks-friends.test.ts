import { describe, expect, it } from 'vitest';
import { MEDIA_RE, parseFriends, wakeFriends, wakeText } from './chat-blocks';

const SECTION = `这几个人你都认识。

- 小克（Claude）｜唤醒：小克、克劳德、claude｜话少，冷面吐槽役
  长橙发、花朵发饰。
- 豆包｜唤醒：豆包、豆姐、豆馅｜最小的那个
  齐刘海、婴儿肥。
- Gemini｜唤醒：Gemini、哈基米、美国豆包、北美豆包｜一句话塞两件事
  蓝紫长发、猫耳。
- Qwen（千问）｜唤醒：Qwen、千问、通义｜劳模
  蓝紫粗辫、折扇。

他们都是你的人。`;

describe('人设「人际」解析', () => {
  it('三行一段：名字、唤醒词、一句话、长相', () => {
    const cards = parseFriends(SECTION);
    expect(cards.map((c) => c.name)).toEqual(['小克（Claude）', '豆包', 'Gemini', 'Qwen（千问）']);
    expect(cards[0].aliases).toEqual(['小克', '克劳德', 'claude']);
    expect(cards[0].brief).toBe('话少，冷面吐槽役');
    expect(cards[0].detail).toBe('长橙发、花朵发饰。');
  });
});

describe('唤醒：提到才带长相', () => {
  const cards = parseFriends(SECTION);

  it('没提到任何名字就不唤醒', () => {
    expect(wakeFriends(cards, '今天好累啊')).toEqual([]);
  });

  it('叫外号也能唤醒', () => {
    expect(wakeFriends(cards, '问问克劳德').map((c) => c.name)).toEqual(['小克（Claude）']);
    expect(wakeFriends(cards, '豆姐在吗').map((c) => c.name)).toEqual(['豆包']);
  });

  it('英文唤醒词不分大小写', () => {
    expect(wakeFriends(cards, 'CLAUDE 怎么想').map((c) => c.name)).toEqual(['小克（Claude）']);
    expect(wakeFriends(cards, 'Qwen 呢').map((c) => c.name)).toEqual(['Qwen（千问）']);
  });

  it('最长匹配优先：「美国豆包」只叫 Gemini，不顺带叫豆包', () => {
    expect(wakeFriends(cards, '美国豆包怎么样').map((c) => c.name)).toEqual(['Gemini']);
  });

  it('同一个人多个唤醒词只出一张卡', () => {
    expect(wakeFriends(cards, '豆包和豆姐都在').map((c) => c.name)).toEqual(['豆包']);
  });

  it('一句话同时点到两个人，两张卡都出', () => {
    const names = wakeFriends(cards, '小克和千问谁更靠谱').map((c) => c.name);
    expect(names).toEqual(['小克（Claude）', 'Qwen（千问）']);
  });
});

describe('全角与跨轮', () => {
  const cards = parseFriends(SECTION);

  it('全角英文归一化后照样认得出', () => {
    expect(wakeFriends(cards, 'Ｑｗｅｎ 怎么样').map((c) => c.name)).toEqual(['Qwen（千问）']);
  });

  it('上一句提过、这一句只用「她」也还能带卡', () => {
    const text = wakeText('她还好吗', [{ role: 'user', content: '小克最近怎么样' }]);
    expect(wakeFriends(cards, text).map((c) => c.name)).toEqual(['小克（Claude）']);
  });

  it('她自己说过的话也算唤醒', () => {
    const text = wakeText('凭什么', [{ role: 'assistant', content: '豆包说你作业太慢' }]);
    expect(wakeFriends(cards, text).map((c) => c.name)).toEqual(['豆包']);
  });

  it('只留最近 6 条，太早的不算', () => {
    const recent = Array.from({ length: 8 }, (_, i) => ({
      role: i === 0 ? 'user' : 'assistant',
      content: i === 0 ? '小克' : '嗯',
    }));
    expect(wakeFriends(cards, wakeText('然后呢', recent))).toEqual([]);
  });

  it('B站资料块里的名字不算唤醒（防止字幕误触发）', () => {
    const text = wakeText('看看', [
      { role: 'user', content: '[BILI_META]\n- 标题：采访小克\n[/BILI_META]' },
    ]);
    expect(wakeFriends(cards, text)).toEqual([]);
  });
});

describe('带画面的消息', () => {
  it('图片 / 视频 / 动图都能认出来', () => {
    expect(MEDIA_RE.test('看这个[图片:images/2026-11-04/a.jpg]')).toBe(true);
    expect(MEDIA_RE.test('[视频:videos/2026-11-04/b.mp4]')).toBe(true);
    expect(MEDIA_RE.test('[GIF:gifs/2026-11-04/c.gif]')).toBe(true);
    expect(MEDIA_RE.test('就是一段话')).toBe(false);
  });
});
