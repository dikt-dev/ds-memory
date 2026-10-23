import { describe, expect, it } from 'vitest';
import {
  cleanUserText,
  extractText,
  isProactiveRequest,
  parseContentParts,
  stripAttachmentWrapper,
  stripImagePlaceholders,
  stripSystemReminder,
  stripSystemNotice,
  withMontageHint,
  buildLastUserContent,
} from './openai';

describe('extractText', () => {
  it('纯字符串内容', () => {
    expect(extractText('你好')).toBe('你好');
  });

  it('多模态数组只取文本部分', () => {
    expect(
      extractText([
        { type: 'text', text: '第一段' },
        { type: 'image_url', image_url: { url: 'https://x/1.png' } },
        { type: 'text', text: '第二段' },
      ]),
    ).toBe('第一段\n第二段');
  });

  it('无文本时返回 null', () => {
    expect(extractText(null)).toBeNull();
    expect(extractText(undefined)).toBeNull();
    expect(extractText(42)).toBeNull();
    expect(extractText([{ type: 'image_url' }])).toBeNull();
    expect(extractText([])).toBeNull();
  });
});

describe('stripSystemReminder', () => {
  it('去掉 AstrBot 追加的元信息', () => {
    expect(stripSystemReminder('小忆\n<system_reminder>User ID: 123, Nickname: x</system_reminder>')).toBe('小忆');
    expect(stripSystemReminder('早\n<system_reminder>Current datetime: 2026-10-21 22:31</system_reminder>')).toBe('早');
  });

  it('没有元信息时原样返回', () => {
    expect(stripSystemReminder('今天天气不错')).toBe('今天天气不错');
  });

  it('只有元信息时返回空串', () => {
    expect(stripSystemReminder('<system_reminder>only meta</system_reminder>')).toBe('');
  });

  it('未闭合的元信息也去掉', () => {
    expect(stripSystemReminder('你好\n<system_reminder>truncated...')).toBe('你好');
  });
});

describe('parseContentParts', () => {
  it('纯字符串', () => {
    expect(parseContentParts('你好')).toEqual({ text: '你好', images: [] });
  });

  it('文本 + 图片数组', () => {
    expect(
      parseContentParts([
        { type: 'text', text: '看看这张' },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,abc' } },
      ]),
    ).toEqual({ text: '看看这张', images: ['data:image/jpeg;base64,abc'] });
  });

  it('只有图片', () => {
    expect(parseContentParts([{ type: 'image_url', image_url: { url: 'https://x/1.png' } }])).toEqual({
      text: '',
      images: ['https://x/1.png'],
    });
  });

  it('空/畸形返回 null', () => {
    expect(parseContentParts(null)).toBeNull();
    expect(parseContentParts(undefined)).toBeNull();
    expect(parseContentParts([])).toBeNull();
    expect(parseContentParts([{ type: 'image_url' }])).toBeNull();
  });
});

describe('stripImagePlaceholders', () => {
  it('去掉 AstrBot 的 [Image N: original path …] 内部路径', () => {
    expect(
      stripImagePlaceholders('你可以看到这张图片吗？\n[Image 1: original path /root/data/temp/media_image_123.jpg]'),
    ).toBe('你可以看到这张图片吗？');
  });

  it('去掉单独的 [图片] 行', () => {
    expect(stripImagePlaceholders('[图片]\n你好')).toBe('你好');
    expect(stripImagePlaceholders('你好\n[图片]')).toBe('你好');
  });

  it('保留正文内容', () => {
    expect(stripImagePlaceholders('看看这个\n[图片]\n好看吗')).toBe('看看这个\n\n好看吗');
  });

  it('无标记时原样返回', () => {
    expect(stripImagePlaceholders('今天天气不错')).toBe('今天天气不错');
  });
});

describe('isProactiveRequest', () => {
  it('识别主动/定时任务消息', () => {
    expect(isProactiveRequest('# CRON JOB CONTEXT\nThe following object describes the scheduled task')).toBe(true);
    expect(isProactiveRequest('You are now responding to a scheduled task. Proceed.')).toBe(true);
  });

  it('普通消息不误判', () => {
    expect(isProactiveRequest('小忆我回来了')).toBe(false);
    expect(isProactiveRequest('今天天气怎么样')).toBe(false);
  });
});

describe('stripAttachmentWrapper', () => {
  const wrapped = [
    '<attachment>',
    '[File Attachment: name 使用方法(1).txt, path /root/data/temp/fileseq_使用方法(1)_727cca7e.txt]',
    '<file_content>',
    '【文件：使用方法(1).txt】',
    '使用方法：',
    'steam右键GBVS 属性-本地文件-浏览（游戏目录），把压缩包解压覆盖进去。',
    '</file_content>',
    '(以上是用户本轮发来的文件内容，请据此回答；如果用户没提具体要求，可以简要说说你看到了什么。)',
    '</attachment>',
  ].join('\n');

  it('只保留 <file_content> 里的真实内容', () => {
    const out = stripAttachmentWrapper(wrapped);
    expect(out).toContain('【文件：使用方法(1).txt】');
    expect(out).toContain('steam右键GBVS');
    expect(out).not.toContain('<attachment>');
    expect(out).not.toContain('</file_content>');
    expect(out).not.toContain('[File Attachment:');
    expect(out).not.toContain('以上是用户本轮发来的文件内容');
  });

  it('保留用户在附件前后的正常文字', () => {
    const out = stripAttachmentWrapper(`帮我看看这个文件\n${wrapped}`);
    expect(out).toContain('帮我看看这个文件');
    expect(out).toContain('steam右键GBVS');
    expect(out).not.toContain('<attachment>');
  });

  it('未闭合的 attachment 也能取出正文', () => {
    const out = stripAttachmentWrapper(
      '看看\n<attachment>\n[File Attachment: name a.txt, path /tmp/a.txt]\n<file_content>\n正文内容\n</file_content>',
    );
    expect(out).toBe('看看\n正文内容');
  });

  it('普通文本原样返回', () => {
    expect(stripAttachmentWrapper('今天天气不错')).toBe('今天天气不错');
    expect(stripAttachmentWrapper('')).toBe('');
  });

  it('可重复调用（幂等）', () => {
    const once = stripAttachmentWrapper(wrapped);
    expect(stripAttachmentWrapper(once)).toBe(once);
  });
});

describe('cleanUserText', () => {
  it('一次清掉 system_reminder、附件包装与图片占位', () => {
    const raw = [
      '[Image 1: original path /root/data/temp/media_x.jpg]',
      '看看这个',
      '<system_reminder>User ID: 1, Nickname: x</system_reminder>',
      '<attachment>',
      '<file_content>文件正文</file_content>',
      '</attachment>',
    ].join('\n');
    expect(cleanUserText(raw)).toBe('看看这个\n文件正文');
  });

  it('清掉平台的 system_notice（动图蒙太奇说明）', () => {
    const raw = [
      '<system_notice>',
      'Images labeled as animation montages contain frames in reading order.',
      '</system_notice>',
      '[图片:images/2026-10-22/1.jpg]',
    ].join('\n');
    expect(cleanUserText(raw)).toBe('[图片:images/2026-10-22/1.jpg]');
    expect(stripSystemNotice('看看<system_notice>truncated')).toBe('看看');
  });

  it('动图蒙太奇才补提示语，普通图片不补', () => {
    const montage = 'Images labeled as animation montages contain frames in reading order.';
    expect(withMontageHint('看图', montage)).toContain('只描述第一个完整画面');
    expect(withMontageHint('看图', '普通一条消息')).toBe('看图');
  });

  it('带图片时提示语也要进请求（上次的 bug 就是这里丢了）', () => {
    const images = [{ type: 'image_url' as const, image_url: { url: 'data:image/jpeg;base64,AAA' } }];
    const montage = 'Images labeled as animation montages contain frames in reading order.';
    const content = buildLastUserContent('你看到了几张图片？', montage, images);
    expect(Array.isArray(content)).toBe(true);
    const parts = content as Array<{ type: string; text?: string }>;
    expect(parts[0].type).toBe('text');
    expect(parts[0].text).toContain('只描述第一个完整画面');
    expect(parts[1].type).toBe('image_url');

    // 普通图片不带提示语
    const plain = buildLastUserContent('看图', '普通消息', images) as Array<{ type: string; text?: string }>;
    expect(plain[0].text).toBe('看图');
  });
});
