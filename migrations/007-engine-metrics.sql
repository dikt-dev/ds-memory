-- 迁移 007：Phase 5 shadow/next 指标聚合
--
-- 用法：
--   wrangler d1 execute ds-memory-db --remote --config wrangler.local.toml \
--     --file=./migrations/007-engine-metrics.sql

CREATE TABLE IF NOT EXISTS engine_metrics (
  day_key    TEXT NOT NULL,
  channel    TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('memory','affect')),
  mode       TEXT NOT NULL,
  requests   INTEGER NOT NULL DEFAULT 0,
  old_items  INTEGER NOT NULL DEFAULT 0,
  new_items  INTEGER NOT NULL DEFAULT 0,
  old_bytes  INTEGER NOT NULL DEFAULT 0,
  new_bytes  INTEGER NOT NULL DEFAULT 0,
  ms_sum     INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (day_key, channel, kind, mode)
);

CREATE INDEX IF NOT EXISTS idx_engine_metrics_day ON engine_metrics(day_key);
