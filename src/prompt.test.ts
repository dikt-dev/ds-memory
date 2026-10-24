import { describe, expect, it } from 'vitest';
import { buildDayContext } from './holidays';
import { buildSystemPrompt, normalizeChannel } from './prompt';

describe('buildSystemPrompt', () => {
  const ctx = buildDayContext('2026-10-21');

  it('注入记忆、日期、节假日、天气与渠道', () => {
    const prompt = buildSystemPrompt({
      now: new Date('2026-10-21T01:00:00Z'),
      ctx,
      memory: '- [2026-10-01] 用户生活在杭州。',
      weather: { city: '杭州', temp_c: 18.5, desc: '晴' },
      channel: 'web',
    });
    expect(prompt).toContain('用户生活在杭州');
    expect(prompt).toContain('2026-10-21 星期三');
    expect(prompt).toContain('工作日');
    expect(prompt).toContain('杭州 晴，18.5°C');
    expect(prompt).toContain('消息来源：网页');
  });

  it('不再把历史对话拼进 system（避免与 messages 重复）', () => {
    const prompt = buildSystemPrompt({
      now: new Date('2026-10-21T01:00:00Z'),
      ctx,
      memory: 'x',
      channel: 'web',
    });
    expect(prompt).not.toContain('## 最近对话');
    expect(prompt).not.toContain('用户：');
  });

  it('稳定内容（记忆）排在易变内容（时间）之前，保证前缀可缓存', () => {
    const prompt = buildSystemPrompt({
      now: new Date('2026-10-21T01:00:00Z'),
      ctx,
      memory: '- [2026-10-01] 用户生活在杭州。',
      channel: 'web',
    });
    const memoryAt = prompt.indexOf('用户生活在杭州');
    const timeAt = prompt.indexOf('## 当前时间与环境');
    expect(memoryAt).toBeGreaterThan(-1);
    expect(timeAt).toBeGreaterThan(-1);
    expect(memoryAt).toBeLessThan(timeAt);
  });

  it('AstrBot 渠道显示对应来源', () => {
    const prompt = buildSystemPrompt({
      now: new Date('2026-10-21T01:00:00Z'),
      ctx,
      memory: 'x',
      channel: 'astrobot',
    });
    expect(prompt).toContain('消息来源：AstrBot');
  });

  it('★ AstrBot 渠道附加「不要用 Markdown」约束（QQ 不渲染）', () => {
    const prompt = buildSystemPrompt({
      now: new Date('2026-10-21T01:00:00Z'),
      ctx,
      memory: 'x',
      channel: 'astrobot',
    });
    expect(prompt).toContain('不支持 Markdown');
    expect(prompt).toContain('[face:表情名]');
  });

  it('注入「最近发过的文件」块', () => {
    const prompt = buildSystemPrompt({
      now: new Date('2026-10-21T01:00:00Z'),
      ctx,
      memory: 'x',
      channel: 'web',
      recentFiles: '## 最近发过的文件\n- 季度报表.xlsx（约 1200 字）',
    });
    expect(prompt).toContain('最近发过的文件');
    expect(prompt).toContain('季度报表.xlsx');
  });

  it('没有文件块时不出现该标题', () => {
    const prompt = buildSystemPrompt({
      now: new Date('2026-10-21T01:00:00Z'),
      ctx,
      memory: 'x',
      channel: 'web',
    });
    expect(prompt).not.toContain('最近发过的文件');
  });

  it('客户端声明语音时才提示可以发 [语音]', () => {
    const withVoice = buildSystemPrompt({
      now: new Date('2026-10-21T01:00:00Z'),
      ctx,
      memory: 'x',
      channel: 'astrobot',
      voiceReply: true,
    });
    expect(withVoice).toContain('[语音]');

    const withoutVoice = buildSystemPrompt({
      now: new Date('2026-10-21T01:00:00Z'),
      ctx,
      memory: 'x',
      channel: 'astrobot',
    });
    expect(withoutVoice).not.toContain('[语音]');
  });

  it('网页渠道不会提示语音', () => {
    const prompt = buildSystemPrompt({
      now: new Date('2026-10-21T01:00:00Z'),
      ctx,
      memory: 'x',
      channel: 'web',
      voiceReply: true,
    });
    expect(prompt).not.toContain('[语音]');
  });

  it('网页渠道不加 Markdown 约束', () => {
    const prompt = buildSystemPrompt({
      now: new Date('2026-10-21T01:00:00Z'),
      ctx,
      memory: 'x',
      channel: 'web',
    });
    expect(prompt).not.toContain('不要用 Markdown');
  });

  it('无记忆时给出占位，不报错', () => {
    const prompt = buildSystemPrompt({
      now: new Date('2026-10-21T01:00:00Z'),
      ctx,
      memory: '',
      channel: 'web',
    });
    expect(prompt).toContain('（暂无记忆）');
  });

  it('角色名可被环境变量覆盖（开源默认是「小忆」）', () => {
    const base = {
      now: new Date('2026-10-21T01:00:00Z'),
      ctx,
      memory: 'x',
      channel: 'web' as const,
    };
    // 未指定：用开源默认值
    expect(buildSystemPrompt(base)).toContain('你是「小忆」');
    // 指定后：换成部署方自己的角色名
    const custom = buildSystemPrompt({ ...base, characterName: '阿七' });
    expect(custom).toContain('你是「阿七」');
    expect(custom).not.toContain('你是「小忆」');
  });

  it('未配置 USER_ADDRESS 时按记忆自然称呼', () => {
    const prompt = buildSystemPrompt({
      now: new Date('2026-10-21T01:00:00Z'),
      ctx,
      memory: 'x',
      channel: 'web',
    });
    expect(prompt).toContain('按记忆里的约定称呼对方');
  });

  it('配置 USER_ADDRESS 后写死该称呼', () => {
    const prompt = buildSystemPrompt({
      now: new Date('2026-10-21T01:00:00Z'),
      ctx,
      memory: 'x',
      channel: 'web',
      userAddress: '主人',
    });
    expect(prompt).toContain('你叫他"主人"');
    expect(prompt).not.toContain('按记忆里的约定称呼对方');
  });
});

describe('normalizeChannel', () => {
  it('合法渠道原样返回', () => {
    expect(normalizeChannel('mobile')).toBe('mobile');
    expect(normalizeChannel('pet')).toBe('pet');
    expect(normalizeChannel('astrobot')).toBe('astrobot');
  });

  it('非法/缺失回退默认值', () => {
    expect(normalizeChannel(undefined)).toBe('web');
    expect(normalizeChannel('unknown-channel')).toBe('web');
    expect(normalizeChannel(42)).toBe('web');
    expect(normalizeChannel(undefined, 'astrobot')).toBe('astrobot');
  });
});
