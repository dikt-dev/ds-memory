import { describe, expect, it } from 'vitest';
import { parsePersonaSections, renderPersonaDoc } from './persona-doc';

const DOC = [
  '# 鲸鱼娘',
  '',
  '## 身份（常驻）',
  '你是鲸鱼娘，自称本小姐。',
  '',
  '<!-- when: 外貌|长相|照片 -->',
  '## 外貌',
  '深蓝长卷发，蓝鲸围裙。',
  '',
  '<!-- when: 朋友|室友 -->',
  '## 人际关系',
  '你和小克是邻居。',
].join('\n');

describe('persona.md 按需分区', () => {
  it('解析出常驻与按需两类', () => {
    const sections = parsePersonaSections(DOC);
    // 第一个 ## 之前的内容（标题行）单独算一段，永远常驻
    expect(sections).toHaveLength(4);
    expect(sections[0].title).toBe('');
    expect(sections[0].when).toBeNull();
    expect(sections[1].when).toBeNull();
    expect(sections[2].when).toEqual(['外貌', '长相', '照片']);
  });

  it('没命中时只带常驻分区', () => {
    const out = renderPersonaDoc(DOC, '今天下雨了');
    expect(out).toContain('自称本小姐');
    expect(out).not.toContain('蓝鲸围裙');
    expect(out).not.toContain('小克');
  });

  it('外貌和人际关系不进常驻段（它们每轮单独带，避免重复）', () => {
    expect(renderPersonaDoc(DOC, '发张照片看看')).not.toContain('蓝鲸围裙');
    expect(renderPersonaDoc(DOC, '你室友是谁')).not.toContain('小克');
  });

  it('空文档返回空串（回退到代码内置骨架）', () => {
    expect(renderPersonaDoc('', '随便说')).toBe('');
  });
});
