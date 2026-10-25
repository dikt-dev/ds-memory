-- 迁移 008：允许 proactive 指标
--
-- 007 的 CHECK 只允许 memory/affect，导致 PROACTIVE_ENGINE=shadow 时
-- recordEngineMetric(kind='proactive') 被 D1 拒绝（写入是静默的，所以很难发现）。
--
-- 用法：
--   wrangler d1 execute ds-memory-db --remote --config wrangler.local.toml \
--     --file=./migrations/008-engine-metrics-proactive.sql

CREATE TABLE engine_metrics_new (
  day_key    TEXT NOT NULL,
  channel    TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('memory','affect','proactive')),
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

INSERT INTO engine_metrics_new
  (day_key, channel, kind, mode, requests, old_items, new_items,
   old_bytes, new_bytes, ms_sum, updated_at)
SELECT
  day_key, channel, kind, mode, requests, old_items, new_items,
  old_bytes, new_bytes, ms_sum, updated_at
FROM engine_metrics;

DROP TABLE engine_metrics;
ALTER TABLE engine_metrics_new RENAME TO engine_metrics;
CREATE INDEX IF NOT EXISTS idx_engine_metrics_day ON engine_metrics(day_key);
