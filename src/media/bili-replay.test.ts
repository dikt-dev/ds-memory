import { describe, expect, it } from 'vitest';
import { hasRecentBili, wantsReplay } from './video-replay';

describe('B 站「再看一眼」触发条件', () => {
  const recent = [{ role: 'user', content: '快看 [BILI_META]\n- 链接：https://b23.tv/x\n[/BILI_META]' }];

  it('追问 + 最近发过 B 站视频才触发', () => {
    expect(wantsReplay('你再看一眼，屏幕上写的什么字')).toBe(true);
    expect(hasRecentBili(recent)).toBe(true);
  });

  it('普通寒暄不触发', () => {
    expect(wantsReplay('在干嘛呀')).toBe(false);
  });

  it('新发一条本地视频时不走重看（那是第一次看）', () => {
    expect(wantsReplay('你看这个 [视频:videos/2026-11-05/a.mp4]')).toBe(false);
  });

  it('最近没发过 B 站视频就不重看', () => {
    expect(hasRecentBili([{ role: 'user', content: '今天天气不错' }])).toBe(false);
  });
});
