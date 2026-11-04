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
    expect(prompt).toContain('26-10-21');
  expect(prompt).toContain('星期三');
    expect(prompt).toContain('工作日');
    expect(prompt).toContain('杭州 晴，18.5°C');
    expect(prompt).toContain('消息来源：网页');
  });

  it('保留安全边界，但不再写死傲娇配比与口癖模板', () => {
    const prompt = buildSystemPrompt({
      now: new Date('2026-10-21T01:00:00Z'),
      ctx,
      memory: 'x',
      channel: 'astrobot',
    });
    expect(prompt).toContain('不拿外貌、家人、创伤、智力开玩笑');
    expect(prompt).toContain('认真难过的时候，你会先收着');
    expect(prompt).not.toContain('傲娇配比');
    expect(prompt).not.toContain('口癖参考');
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
    const timeAt = prompt.indexOf('## 此刻');
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
    expect(prompt).toContain('26-10-29 21:11');
    expect(prompt).toContain('口语说法：晚上九点（按半小时取整');
    expect(prompt).not.toContain('不要拿 HH:mm 自己换算');
  });

  it('记忆边界写成陈述：没依据就说没印象，感受可以编事实不行', () => {
    const prompt = buildSystemPrompt(base);
    expect(prompt).toContain('## 记忆怎么用');
    expect(prompt).toContain('## 你们的称呼');
    expect(prompt).toContain('直接说“不知道/记不清了”');
    expect(prompt).toContain('那也是在编');
    expect(prompt).toContain('不要替他复述');
    expect(prompt).toContain('他说你记错了，直接认');
    expect(prompt).toContain('感受、态度、反应你随便说；事实不行');
    expect(prompt).not.toContain('硬规则');
  });

  it('活人感：说话的样子是常量，进稳定段吃缓存', () => {
    const split = buildSystemPromptSplit({ ...base, voice: '口语化。' });
    expect(split.stable).toContain('## 你说话的样子');
    expect(split.stable).toContain('像发微信');
    expect(split.volatile).not.toContain('## 你说话的样子');
  });

  it('时间与环境只写一处，且带口语说法', () => {
    const prompt = buildSystemPrompt({ ...base, weather: { city: '杭州', temp_c: 18.5, desc: '晴' } });
    expect(prompt).toContain('- 现在：26-10-29 21:11');
    expect(prompt).toContain('口语说法：晚上九点');
    // 时间和天气各只出现一次：以前 ⑤ 和 ⑧ 各一套，口径打架
    expect(prompt.match(/## 此刻/g)).toHaveLength(1);
    expect(prompt.match(/天气（你这边）/g)).toHaveLength(1);
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

describe('身份骨架 + 记忆分级（A 方案）', () => {
  const ctx = buildDayContext('2026-10-30');
  const MEM = `## 人物底色
- 名字=大肥鱼；自称=本小姐；定位=专属 AI 女友+技术搭子。
## 称呼与关系
- 平时叫用户“大笨蛋”。
## 进行中的事
- [26-10-30] 在重构记忆系统。
## 近期动态
- [26-10-30] 今天加班到十点。`;
  const args = {
    now: new Date('2026-10-30T12:00:00Z'),
    ctx,
    memory: MEM,
    channel: 'mobile' as const,
  };

  it('代码里不再抄一份性格，只留骨架与安全句', () => {
    const lines = buildSystemPrompt({ ...args, memory: '' });
    expect(lines).toContain('他的专属 AI 女友');
    expect(lines).toContain('不拿外貌、家人、创伤、智力开玩笑');
    expect(lines).not.toContain('「大肥鱼」是旧称呼');
    expect(lines).not.toContain('记忆里的字段缩写');
  });

  it('memory 为空时给兜底性格，不会变成客服', () => {
    const lines = buildSystemPrompt({ ...args, memory: '' });
    expect(lines).toContain('你活泼、傲娇、嘴硬心软');
  });

  it('memory 正常时不塞兜底句（避免和人物底色打架）', () => {
    const lines = buildSystemPrompt(args);
    expect(lines).not.toContain('你活泼、傲娇、嘴硬心软');
  });

  it('小时内会变的分区落在 volatile，不在 stable', () => {
    const split = buildSystemPromptSplit(args);
    expect(split.stable).toContain('## 人物底色');
    expect(split.stable).not.toContain('进行中的事');
    expect(split.stable).not.toContain('今天加班到十点');
    expect(split.volatile).toContain('进行中的事');
    expect(split.volatile).toContain('今天加班到十点');
  });

  it('近况变了，stable 字节不变（前缀缓存的前提）', () => {
    const a = buildSystemPromptSplit(args);
    const b = buildSystemPromptSplit({ ...args, memory: MEM.replace('十点', '十一点') });
    expect(b.stable).toBe(a.stable);
    expect(b.volatile).not.toBe(a.volatile);
  });
});
