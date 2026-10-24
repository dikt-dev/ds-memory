-- 迁移 003：Phase 1 运行时状态 + 无状态鉴权吊销表
--
-- 用法：
--   wrangler d1 execute ds-memory-db --remote --config wrangler.local.toml \
--     --file=./migrations/003-runtime-state-auth.sql
--
-- 说明：
--   1) runtime_state 替代高频 KV（心跳、情绪、锁、画像脏标记、天气、成本等）；
--   2) auth_revocations 只用于「全部登出」的全局吊销；
--   3) 表使用 IF NOT EXISTS，可重复执行。

CREATE TABLE IF NOT EXISTS runtime_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_runtime_state_expires
  ON runtime_state(expires_at);

CREATE TABLE IF NOT EXISTS auth_revocations (
  scope      TEXT PRIMARY KEY,   -- 'global' 或 token jti
  revoked_at INTEGER NOT NULL
);
