import { describe, expect, it } from 'vitest';
import { classifyConsent } from './diary';

/** 「就一眼」是有限度的同意，不能当成全文放行，也不能当成拒绝。 */
describe('peek：只肯给看一眼', () => {
  it('看一眼 / 瞄一眼 / 一行 判成 peek', () => {
    expect(classifyConsent('那你就看一次，一行就够了')).toBe('peek');
    expect(classifyConsent('行吧，给你瞄一眼')).toBe('peek');
    expect(classifyConsent('只看格式，正文别瞄')).toBe('peek');
  });

  it('整篇给你才算同意', () => {
    expect(classifyConsent('好吧，给你看')).toBe('yes');
  });

  it('明确拒绝还是拒绝', () => {
    expect(classifyConsent('不给。凭什么给你看')).toBe('no');
  });
});
