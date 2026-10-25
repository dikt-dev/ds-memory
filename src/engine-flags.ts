/**
 * 渠道级引擎开关（Phase 5）。
 *
 * 切换顺序 QQ → 网页 → 主动消息，因此不能只有一个全局开关：
 * - `MEMORY_ENGINE_QQ` / `AFFECT_ENGINE_QQ` 覆盖 QQ（astrobot）；
 * - `MEMORY_ENGINE_MOBILE` / `AFFECT_ENGINE_MOBILE` 覆盖 DS-Mobile；
 * - `MEMORY_ENGINE_WEB` / `AFFECT_ENGINE_WEB` 覆盖网页/其它；
 * - 未设置时回退全局 `MEMORY_ENGINE` / `AFFECT_ENGINE`，再回退 legacy。
 */
import type { Env } from './types';

export type EngineMode = 'legacy' | 'shadow' | 'next';

export function normalizeEngine(value: string | undefined | null): EngineMode {
  const v = (value ?? 'legacy').toLowerCase();
  return v === 'shadow' || v === 'next' ? v : 'legacy';
}

function channelOverride(
  env: Env,
  channel: string,
  qqKey: 'MEMORY_ENGINE_QQ' | 'AFFECT_ENGINE_QQ',
  mobileKey: 'MEMORY_ENGINE_MOBILE' | 'AFFECT_ENGINE_MOBILE',
  webKey: 'MEMORY_ENGINE_WEB' | 'AFFECT_ENGINE_WEB',
): string | undefined {
  if (channel === 'astrobot') return env[qqKey];
  if (channel === 'mobile') return env[mobileKey];
  return env[webKey];
}

export function memoryEngineFor(env: Env, channel: string): EngineMode {
  return normalizeEngine(
    channelOverride(
      env,
      channel,
      'MEMORY_ENGINE_QQ',
      'MEMORY_ENGINE_MOBILE',
      'MEMORY_ENGINE_WEB',
    ) ?? env.MEMORY_ENGINE,
  );
}

export function affectEngineFor(env: Env, channel: string): EngineMode {
  return normalizeEngine(
    channelOverride(
      env,
      channel,
      'AFFECT_ENGINE_QQ',
      'AFFECT_ENGINE_MOBILE',
      'AFFECT_ENGINE_WEB',
    ) ?? env.AFFECT_ENGINE,
  );
}

/** 主动消息是最后一条链路，单独开关，避免和 QQ/网页切流耦合。 */
export function proactiveEngineFor(env: Env): EngineMode {
  return normalizeEngine(env.PROACTIVE_ENGINE);
}
