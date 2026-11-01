import { describe, expect, it } from 'vitest';
import { insertLineIntoText } from './memory-append';

const BASE = `# 长期记忆

## 人物底色

- 她嘴硬心软

## 共同经历

- 一起看过日出

## 雷区与禁忌

- 不许提体重
`;

describe('insertLineIntoText', () => {
  it('追加到已存在的分区末尾', () => {
    const { text } = insertLineIntoText(BASE, '## 共同经历', '- 一起修好了自行车');
    expect(text).toContain('- 一起看过日出\n- 一起修好了自行车');
    expect(text.indexOf('一起修好了自行车')).toBeLessThan(text.indexOf('## 雷区与禁忌'));
  });

  it('分区不存在时按标准顺序新建，且不重复插入同一行', () => {
    const { text } = insertLineIntoText(BASE, '## 她的生活', '- 在追《芙莉莲》');
    // 顺序：共同经历 < 她的生活 < 雷区与禁忌
    expect(text.indexOf('## 共同经历')).toBeLessThan(text.indexOf('## 她的生活'));
    expect(text.indexOf('## 她的生活')).toBeLessThan(text.indexOf('## 雷区与禁忌'));
    // 关键：只出现一次（新建 block 里带了这一行，不能再插一遍）
    expect(text.split('- 在追《芙莉莲》').length - 1).toBe(1);
    // 注释在标题下面
    expect(text.indexOf('## 她的生活')).toBeLessThan(text.indexOf('她自己的事'));
  });

  it('整行已存在时返回 exists，不改文本', () => {
    const { text, reason } = insertLineIntoText(BASE, '## 共同经历', '- 一起看过日出');
    expect(reason).toBe('exists');
    expect(text).toBe(BASE);
  });

  it('未知分区被拒绝（只认标准分区，不凭空造节）', () => {
    const { text, reason } = insertLineIntoText(BASE, '## 随便写的', '- x');
    expect(reason).toBe('no-section');
    expect(text).toBe(BASE);
  });
});
