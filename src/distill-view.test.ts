import { describe, expect, it } from 'vitest';
import {
  buildDistillConversation,
  collapseFileBlocks,
  sanitizeDistilledSummary,
} from './distill-view';

describe('collapseFileBlocks', () => {
  it('粘贴的文件块只留文件名', () => {
    const input = '看下这个【文件：TASKS.md】\n\n```md\n# 任务总表\n- 一堆内容\n```\n好的';
    const out = collapseFileBlocks(input);
    expect(out).toContain('【文件：TASKS.md】（正文已省略）');
    expect(out).not.toContain('任务总表');
    expect(out).toContain('好的');
  });

  it('没有正文的纯标记原样保留文件名', () => {
    expect(collapseFileBlocks('【文件：a.pdf】看完了')).toBe('【文件：a.pdf】看完了');
  });
});

describe('buildDistillConversation', () => {
  it('她的长回复不再被砍到 400 字', () => {
    const long = '啊'.repeat(3000);
    const out = buildDistillConversation([
      { role: 'user', content: '今天有点累' },
      { role: 'assistant', content: long },
    ]);
    expect(out).toContain('用户：今天有点累');
    expect(out).toContain('啊'.repeat(3000));
  });

  it('超过 12000 字的用户消息才截断', () => {
    expect(
      buildDistillConversation([{ role: 'user', content: '字'.repeat(9000) }]),
    ).not.toContain('后略');
    const out = buildDistillConversation([{ role: 'user', content: '字'.repeat(13000) }]);
    expect(out).toContain('后略 1000 字');
  });

  it('主动消息单独标注', () => {
    const out = buildDistillConversation([
      { role: 'assistant', content: '早', turn_type: 'proactive' },
    ]);
    expect(out).toContain('助手（主动发起，用户未回复）：早');
  });

  it('图片/视频占位符压成标记，不带 R2 路径', () => {
    const out = buildDistillConversation([
      { role: 'user', content: '看\n[视频:videos/2026-10-30/abc.mp4]' },
    ]);
    expect(out).toContain('[视频]');
    expect(out).not.toContain('videos/2026-10-30');
  });
});

describe('sanitizeDistilledSummary', () => {
  it('只留分区标题与记忆条目', () => {
    const raw = [
      '## 共同经历',
      '',
      '- [26-10-30] 用户被投喂了一下午 B 站视频',
      '- 心情值：455 / 1000',
      '一些解释性废话',
      '## 进行中的事',
      '- [26-10-30] [进行中] 11-01 解冻部署',
    ].join('\n');
    const out = sanitizeDistilledSummary(raw);
    expect(out).toContain('## 共同经历');
    expect(out).toContain('用户被投喂了一下午');
    expect(out).not.toContain('心情值');
    expect(out).not.toContain('解释性废话');
  });
});
