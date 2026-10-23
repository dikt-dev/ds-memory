/**
 * 角色身份配置（可部署时覆盖）。
 *
 * 开源默认值在这里；部署者可以在 wrangler.toml（或本地 wrangler.local.toml）
 * 里用环境变量覆盖，**不必改动源码**，因此私有设定不会进入公开仓库。
 *
 *   [vars]
 *   CHARACTER_NAME = "阿七"        # 角色的自称（出现在系统提示词与状态卡里）
 *   USER_ADDRESS   = "主人"        # 期望对方怎么称呼自己；留空则按记忆自然称呼
 */

/** 开源默认角色名（未配置环境变量时使用）。 */
export const DEFAULT_CHARACTER_NAME = '小忆';

/** 可注入角色名的环境变量子集。 */
export interface CharacterEnv {
  CHARACTER_NAME?: string;
  USER_ADDRESS?: string;
}

/** 解析角色名：环境变量优先，空值/空白回退到开源默认值。 */
export function resolveCharacterName(env: CharacterEnv | undefined): string {
  const name = env?.CHARACTER_NAME?.trim();
  return name || DEFAULT_CHARACTER_NAME;
}

/**
 * 解析「对方怎么被称呼」。
 *
 * 返回 null 表示未指定 —— 此时提示词让模型按记忆里的约定自然称呼，
 * 不要硬塞一个固定称谓。
 */
export function resolveUserAddress(env: CharacterEnv | undefined): string | null {
  const address = env?.USER_ADDRESS?.trim();
  return address || null;
}
