/**
 * 提示词记忆模式（ADR-001 S6）。
 *
 * full     —— 老行为：memory.md 全量注入（≤16KB 时）。
 * evidence —— 新行为：只注入宪法四节，其余靠多路召回的「证据集」。
 *
 * 之所以用开关而不是直接切：这是唯一一处会影响她每一句话的改动，
 * 先能一键退回，再谈质量。
 */
import type { Env } from './types';

export type PromptMemoryMode = 'full' | 'evidence';

export function promptModeFor(env: Env): PromptMemoryMode {
  return env.MEMORY_PROMPT_MODE === 'evidence' ? 'evidence' : 'full';
}
