import { afterEach, expect, it, vi } from 'vitest';
import { parseDiaryOutput } from './diary';
import { judgeDiaryConsent } from './consent-judge';

afterEach(() => vi.restoreAllMocks());

it('解析出写日记时留的摘要', () => {
  const raw = '今天去了那个展，站了很久。\n{"share": false, "summary": "看展，写了点委屈", "reason": "不想给看"}';
  const d = parseDiaryOutput(raw);
  expect(d.text).toContain('那个展');
  expect(d.summary).toBe('看展，写了点委屈');
  expect(d.share).toBe(false);
});

it('JSON 坏掉也能用正则捞出摘要', () => {
  const raw = '正文。\n{"share": true, "summary": "日常琐事", "reason": \'x\'}';
  expect(parseDiaryOutput(raw).summary).toBe('日常琐事');
});

it('摘要会进判断提示词（让模型知道这篇写了什么）', async () => {
  let sent = '';
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    sent = String(init.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"decision":"allow"}' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  const env = { DEEPSEEK_API_KEY: 'k', DEEPSEEK_MODEL: 'deepseek-chat' } as never;
  await judgeDiaryConsent(env, [{ role: 'user', content: '给我看日记' }], {
    dates: ['2026-10-31'],
    summaries: [{ date: '2026-10-31', summary: '写了委屈，没提他' }],
  });
  expect(sent).toContain('写了委屈，没提他');
  expect(sent).toContain('2026-10-31');
});

it('JSON 被截断时也要把正文留下、别把半截 JSON 当日记', () => {
  const raw = '今天下了点雨，没出门。{"share": false, "summary": "提到他，有点想';
  const d = parseDiaryOutput(raw);
  expect(d.text).toBe('今天下了点雨，没出门。');
  expect(d.summary).toBeUndefined();
});
