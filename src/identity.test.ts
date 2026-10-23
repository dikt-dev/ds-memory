import { describe, expect, it } from 'vitest';
import { DEFAULT_CHARACTER_NAME, resolveCharacterName, resolveUserAddress } from './identity';

describe('resolveCharacterName', () => {
  it('未配置时回退到开源默认角色名', () => {
    expect(resolveCharacterName(undefined)).toBe(DEFAULT_CHARACTER_NAME);
    expect(resolveCharacterName({})).toBe(DEFAULT_CHARACTER_NAME);
    expect(DEFAULT_CHARACTER_NAME).toBe('小忆');
  });

  it('配置后使用部署方自己的角色名', () => {
    expect(resolveCharacterName({ CHARACTER_NAME: '阿七' })).toBe('阿七');
  });

  it('空白值视为未配置（防止误写成空字符串把文案搞坏）', () => {
    expect(resolveCharacterName({ CHARACTER_NAME: '' })).toBe(DEFAULT_CHARACTER_NAME);
    expect(resolveCharacterName({ CHARACTER_NAME: '   ' })).toBe(DEFAULT_CHARACTER_NAME);
  });

  it('去掉首尾空格', () => {
    expect(resolveCharacterName({ CHARACTER_NAME: '  阿七  ' })).toBe('阿七');
  });
});

describe('resolveUserAddress', () => {
  it('未配置时返回 null，让提示词按记忆自然称呼', () => {
    expect(resolveUserAddress(undefined)).toBeNull();
    expect(resolveUserAddress({})).toBeNull();
    expect(resolveUserAddress({ USER_ADDRESS: '' })).toBeNull();
    expect(resolveUserAddress({ USER_ADDRESS: '  ' })).toBeNull();
  });

  it('配置后返回该称呼', () => {
    expect(resolveUserAddress({ USER_ADDRESS: '主人' })).toBe('主人');
    expect(resolveUserAddress({ USER_ADDRESS: '  主人 ' })).toBe('主人');
  });
});
