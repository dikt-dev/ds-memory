-- 迁移 005：Phase 2B 可重试记忆任务表
--
-- 用法：
--   wrangler d1 execute ds-memory-db --remote --config wrangler.local.toml \
--     --file=./migrations/005-memory-jobs.sql

CREATE TABLE IF NOT EXISTS memory_jobs (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL,
  target      TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'queued'
              CHECK (status IN ('queued','running','done','failed')),
  attempts    INTEGER NOT NULL DEFAULT 0,
  error       TEXT,
  created_at  INTEGER NOT NULL,
  started_at  INTEGER,
  finished_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_memory_jobs_status ON memory_jobs(status, created_at);
