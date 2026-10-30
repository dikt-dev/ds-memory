import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TTS_CONFIG,
  buildSsml,
  loadTtsConfig,
  sanitizeTtsConfig,
  saveTtsConfig,
  styleForText,
  ttsCacheKey,
} from './tts-config';
import type { Env } from './types';

class FakeKV {
  store = new Map<string, string>();
  async get(key: string) {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  async put(key: string, value: string) {
    this.store.set(key, value);
  }
}

const envWith = (kv: FakeKV) => ({ KV: kv } as unknown as Env);

describe('sanitizeTtsConfig', () => {
  it('空输入给出默认值', () => {
    const cfg = sanitizeTtsConfig(null);
    expect(cfg.voice).toBe(DEFAULT_TTS_CONFIG.voice);
    expect(cfg.rate).toBe('+5%');
    expect(cfg.pitch).toBe('+3Hz');
    expect(cfg.style_degree).toBe('1.2');
    expect(cfg.style_mode).toBe('auto');
  });

  it('保留合法参数', () => {
    const cfg = sanitizeTtsConfig({
      voice: 'zh-CN-YunxiNeural',
      rate: '-10%',
      pitch: '-2Hz',
      style_degree: '0.8',
      style_mode: 'off',
    });
    expect(cfg).toMatchObject({
      voice: 'zh-CN-YunxiNeural',
      rate: '-10%',
      pitch: '-2Hz',
      style_degree: '0.8',
      style_mode: 'off',
    });
  });

  it('挡住 SSML 注入和非法数值', () => {
    const cfg = sanitizeTtsConfig({
      voice: 'zh-CN-XiaoyiNeural\"><break time="5s"/>',
      rate: 'fast 100%',
      pitch: '<prosody>',
      style_degree: 'abc',
    });
    expect(cfg.voice).toBe(DEFAULT_TTS_CONFIG.voice);
    expect(cfg.rate).toBe(DEFAULT_TTS_CONFIG.rate);
    expect(cfg.pitch).toBe(DEFAULT_TTS_CONFIG.pitch);
    expect(cfg.style_degree).toBe(DEFAULT_TTS_CONFIG.style_degree);
  });
});

describe('loadTtsConfig / saveTtsConfig', () => {
  it('没有记录时返回默认值', async () => {
    const cfg = await loadTtsConfig(envWith(new FakeKV()));
    expect(cfg.voice).toBe(DEFAULT_TTS_CONFIG.voice);
  });

  it('存进去能读出来，且带上 updated_at', async () => {
    const kv = new FakeKV();
    const saved = await saveTtsConfig(envWith(kv), { voice: 'zh-CN-YunxiNeural', rate: '+8%' });
    expect(saved.updated_at).toBeGreaterThan(0);
    const back = await loadTtsConfig(envWith(kv));
    expect(back.voice).toBe('zh-CN-YunxiNeural');
    expect(back.rate).toBe('+8%');
    expect(back.pitch).toBe(DEFAULT_TTS_CONFIG.pitch);
  });

  it('记录损坏时退回默认值而不是抛错', async () => {
    const kv = new FakeKV();
    kv.store.set('tts:config', '{oops');
    const cfg = await loadTtsConfig(envWith(kv));
    expect(cfg.voice).toBe(DEFAULT_TTS_CONFIG.voice);
  });
});

describe('styleForText', () => {
  it('按中文关键词挑情绪', () => {
    expect(styleForText('嘘，小声点')).toBe('whispering');
    expect(styleForText('哼，才不稀罕')).toBe('disgruntled');
    expect(styleForText('你这话让我很生气')).toBe('angry');
    expect(styleForText('有点委屈')).toBe('sad');
    expect(styleForText('别担心，慢慢来')).toBe('gentle');
    expect(styleForText('太棒了')).toBe('excited');
    expect(styleForText('我懂你，辛苦了')).toBe('empathetic');
    expect(styleForText('今天挺开心')).toBe('cheerful');
  });

  it('普通句子不加情绪', () => {
    expect(styleForText('七点一刻，别忘了')).toBe('');
  });

  it('安慰类句子判成 gentle', () => {
    expect(styleForText('别担心，我在')).toBe('gentle');
  });

  it('顺序从强到弱：委屈压过安慰', () => {
    expect(styleForText('我懂，可我还是觉得委屈')).toBe('sad');
  });
});

describe('buildSsml', () => {
  it('带 style 时包 express-as，并转义文本', () => {
    const ssml = buildSsml('a<b>&"', DEFAULT_TTS_CONFIG, 'gentle');
    expect(ssml).toContain('express-as');
    expect(ssml).toContain('a&lt;b&gt;&amp;&quot;');
    expect(ssml).toContain(`name='${DEFAULT_TTS_CONFIG.voice}'`);
  });

  it('没有 style 时不包 express-as', () => {
    const ssml = buildSsml('你好', DEFAULT_TTS_CONFIG, '');
    expect(ssml).not.toContain('express-as');
    expect(ssml).toContain("rate='+5%'");
    expect(ssml).toContain("pitch='+3Hz'");
  });
});

describe('ttsCacheKey', () => {
  it('同文本同参数 → 同 key，换音色 → 换 key', async () => {
    const a = await ttsCacheKey('你好', DEFAULT_TTS_CONFIG, 'gentle');
    const b = await ttsCacheKey('你好', DEFAULT_TTS_CONFIG, 'gentle');
    const c = await ttsCacheKey('你好', { ...DEFAULT_TTS_CONFIG, voice: 'zh-CN-YunxiNeural' }, 'gentle');
    const d = await ttsCacheKey('你好', DEFAULT_TTS_CONFIG, 'angry');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toBe(d);
    expect(a.startsWith('tts/cache/')).toBe(true);
  });
});