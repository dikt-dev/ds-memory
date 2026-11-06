import { describe, expect, it } from 'vitest';
import { auditSubjects, classifyActor, isActionEntry, suggestRewrite } from './subject-guard';

describe('classifyActor', () => {
  it('「他」是 user，「你」是她（2026-11-06 起代词统一）', () => {
    expect(classifyActor('用户熬夜调通了 AstrBot')).toBe('user');
    expect(classifyActor('他换了新手机')).toBe('user');
    expect(classifyActor('你换了新手机')).toBe('assistant');
  });

  it('显式她自己 是 assistant', () => {
    expect(classifyActor('她当时笑了一下')).toBe('assistant');
    expect(classifyActor('我说了句晚安')).toBe('assistant');
  });

  it('两边都出现判 joint，不硬二选一', () => {
    expect(classifyActor('用户写代码，她负责吐槽')).toBe('joint');
  });

  it('一起/我们 算 joint', () => {
    expect(classifyActor('一起调通了 AstrBot')).toBe('joint');
  });

  it('没有主体是 unclear', () => {
    expect(classifyActor('熬夜把监控脚本调好了')).toBe('unclear');
  });
});

describe('isActionEntry', () => {
  it('动作句算，静态偏好不算', () => {
    expect(isActionEntry('熬夜调通 AstrBot')).toBe(true);
    expect(isActionEntry('颜色=蓝')).toBe(false);
  });
});

describe('auditSubjects', () => {
  const doc = [
    '## 关于他',
    '- 职业=嵌入式开发',
    '- 熬夜调通了 AstrBot',
    '## 共同经历',
    '- [26-10-30] 一起看完了可塑性记忆',
    '- [26-10-30] 半夜写了监控脚本',
    '## 人物底色',
    '- 嘴硬心软，不会直说想你',
  ].join('\n');

  it('「关于他」整节默认主语是用户，不报警', () => {
    const issues = auditSubjects(doc);
    expect(issues.map((i) => i.line)).toEqual(['半夜写了监控脚本']);
  });

  it('键=值 静态事实跳过', () => {
    expect(auditSubjects(doc).some((i) => i.line.includes('职业='))).toBe(false);
  });

  it('核心区（人物底色）不参与判断', () => {
    expect(auditSubjects(doc).some((i) => i.section === '人物底色')).toBe(false);
  });

  it('有主体的条目不报', () => {
    const clean = '## 进行中的事\n- 他写了回滚草稿\n- 你提醒了三次';
    expect(auditSubjects(clean)).toEqual([]);
  });

  it('空文档不炸', () => {
    expect(auditSubjects('')).toEqual([]);
  });
});

describe('suggestRewrite', () => {
  it('默认归给他', () => {
    expect(suggestRewrite('熬夜调通了 AstrBot')).toBe('他熬夜调通了 AstrBot');
  });

  it('带状态标签时插在标签后面', () => {
    expect(suggestRewrite('[进行中] 监控脚本调好了')).toBe('[进行中] 他监控脚本调好了');
  });
});