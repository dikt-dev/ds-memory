import { describe, expect, it } from 'vitest';
import { buildDayContext } from './holidays';
import { buildSystemPrompt, buildSystemPromptSplit, isSilentEnd, normalizeChannel, stripSilentEndToken } from './prompt';

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

  it('包含傲娇/活泼/毒舌的强度与安全边界', () => {
    const prompt = buildSystemPrompt({
      now: new Date('2026-10-21T01:00:00Z'),
      ctx,
      memory: 'x',
      channel: 'astrobot',
    });
    expect(prompt).toContain('傲娇配比');
    expect(prompt).toContain('毒舌要有分寸');
    expect(prompt).toContain('不攻击外貌、家人、创伤、智力');
    expect(prompt).toContain('认真难过时先收毒舌');
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

  it('网页渠道支持语音时也提示 [语音]', () => {
    const prompt = buildSystemPrompt({
      now: new Date('2026-10-21T01:00:00Z'),
      ctx,
      memory: 'x',
      channel: 'web',
      voiceReply: true,
    });
    expect(prompt).toContain('[语音]');
    expect(prompt).toContain('想发语音时');
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

describe('silent end parsing', () => {
  it('接受标记单独出现或带标点', () => {
    expect(isSilentEnd('[END]')).toBe(true);
    expect(isSilentEnd('  [END]。 ')).toBe(true);
  });

  it('正文附加标记不算静默，标记会被剔除', () => {
    expect(isSilentEnd('嗯，睡吧。……[END]')).toBe(false);
    expect(isSilentEnd('晚安\n[END]')).toBe(false);
    expect(stripSilentEndToken('嗯，睡吧。……[END]')).toBe('嗯，睡吧。……');
  });

  it('标记后面还有正文时不静默', () => {
    expect(isSilentEnd('[END] 但是还有话')).toBe(false);
    expect(isSilentEnd('普通文本提到 [END] 但不是结尾')).toBe(false);
  });

  it('任何路径都剔除标记', () => {
    expect(stripSilentEndToken('正文[END]')).toBe('正文');
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
describe('时间与诚实性规则', () => {
  const ctx = buildDayContext('2026-10-29');
  const base = {
    now: new Date('2026-10-29T13:11:00Z'),
    ctx,
    memory: 'x',
    channel: 'web' as const,
  };

  it('同时给出 ISO 时间和按半小时取整的口语说法', () => {
    const prompt = buildSystemPrompt(base);
    expect(prompt).toContain('2026-10-29T21:11:00+08:00');
    expect(prompt).toContain('口语说法：晚上九点（按半小时取整');
    expect(prompt).not.toContain('不要拿 HH:mm 自己换算');
  });

  it('含“不记得就说不知道”的硬规则，禁止编造事实', () => {
    const prompt = buildSystemPrompt(base);
    expect(prompt).toContain('## 记忆缺失时怎么说（硬规则）');
    expect(prompt).toContain('不能编造事实');
    expect(prompt).toContain('直接说“不记得/没印象/你没跟我说过”');
  });

  it('实时事实块里也带口语时间', () => {
    const prompt = buildSystemPrompt(base);
    expect(prompt).toContain('现在=2026-10-29T21:11:00+08:00（晚上九点；');
  });
});

describe('buildSystemPromptSplit（前缀缓存）', () => {
  const ctx = buildDayContext('2026-10-21');

  it('稳定段不随时间变化：两轮不同时刻，稳定段字节一致', () => {
    const base = {
      ctx,
      memory: '- 用户生活在杭州。',
      channel: 'mobile' as const,
      characterCard: '你有点困',
      recalled: '## 相关往事\n- 昨天他说要早睡',
      attitude: '现在心情不错',
      weather: { city: '杭州', temp_c: 18.5, desc: '晴' },
    };
    const a = buildSystemPromptSplit({ ...base, now: new Date('2026-10-21T01:00:00Z') });
    const b = buildSystemPromptSplit({ ...base, now: new Date('2026-10-21T09:30:00Z') });
    expect(a.stable).toBe(b.stable);
    expect(a.volatile).not.toBe(b.volatile);
  });

  it('易变内容不进稳定段', () => {
    const split = buildSystemPromptSplit({
      now: new Date('2026-10-21T01:00:00Z'),
      ctx,
      memory: '- 用户生活在杭州。',
      channel: 'mobile',
      characterCard: '你有点困',
      recalled: '## 相关往事\n- 昨天他说要早睡',
      weather: { city: '杭州', temp_c: 18.5, desc: '晴' },
    });
    expect(split.stable).toContain('用户生活在杭州');
    expect(split.stable).not.toContain('杭州 晴');
    expect(split.volatile).toContain('杭州 晴');
    expect(split.volatile).toContain('昨天他说要早睡');
  });

  it('拼接后与完整提示词内容一致（不丢段）', () => {
    const args = {
      now: new Date('2026-10-21T01:00:00Z'),
      ctx,
      memory: '- 用户生活在杭州。',
      channel: 'web' as const,
      characterCard: '你有点困',
    };
    const split = buildSystemPromptSplit(args);
    const all = buildSystemPrompt(args);
    for (const piece of split.stable.split('\n').filter((s) => s.startsWith('## '))) {
      expect(all).toContain(piece);
    }
    expect(split.stable.length + split.volatile.length).toBeGreaterThan(0);
  });
});
