-- 迁移 027：补齐「代码里运行期建表」的四张表
--
-- 为什么需要：cmid_cache / request_log / recall_samples / engine_cpu 都在代码里
-- CREATE TABLE IF NOT EXISTS，生产库是先跑起来才有的；照 schema.sql 新建的环境里
-- 这些表不存在，查询失败被 catch 吞掉 → 消息去重静默失效（2026-11-08 复盘）。
-- 全部幂等，可重复执行。

CREATE TABLE IF NOT EXISTS cmid_cache (
  client_message_id    TEXT PRIMARY KEY,
  content              TEXT NOT NULL,
  user_message_id      INTEGER,
  assistant_message_id INTEGER,
  created_at           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cmid_cache_at ON cmid_cache(created_at);

CREATE TABLE IF NOT EXISTS request_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         INTEGER NOT NULL,
  request_id TEXT NOT NULL DEFAULT 'none',
  kind       TEXT NOT NULL,
  method     TEXT NOT NULL DEFAULT '',
  path       TEXT NOT NULL,
  status     INTEGER NOT NULL DEFAULT 0,
  ms         INTEGER NOT NULL DEFAULT 0,
  channel    TEXT NOT NULL DEFAULT '',
  ok         INTEGER NOT NULL DEFAULT 1,
  detail     TEXT
);
CREATE INDEX IF NOT EXISTS idx_request_log_at ON request_log(at);
CREATE INDEX IF NOT EXISTS idx_request_log_path ON request_log(path, at);

CREATE TABLE IF NOT EXISTS recall_samples (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  day_key          TEXT NOT NULL,
  channel          TEXT NOT NULL,
  mode             TEXT NOT NULL,
  kind             TEXT NOT NULL,
  legacy_ms        INTEGER NOT NULL DEFAULT 0,
  load_ms          INTEGER NOT NULL DEFAULT 0,
  rank_ms          INTEGER NOT NULL DEFAULT 0,
  rank_inner_ms    INTEGER NOT NULL DEFAULT 0,
  select_ms        INTEGER NOT NULL DEFAULT 0,
  embed_ms         INTEGER NOT NULL DEFAULT 0,
  expand_ms        INTEGER NOT NULL DEFAULT 0,
  total_ms         INTEGER NOT NULL DEFAULT 0,
  items            INTEGER NOT NULL DEFAULT 0,
  linked           INTEGER NOT NULL DEFAULT 0,
  has_vector       INTEGER NOT NULL DEFAULT 0,
  timed_out        INTEGER NOT NULL DEFAULT 0,
  legacy_skipped   INTEGER NOT NULL DEFAULT 0,
  covered          INTEGER NOT NULL DEFAULT 0,
  uncovered        INTEGER NOT NULL DEFAULT 0,
  selector_skipped INTEGER NOT NULL DEFAULT 0,
  intents          TEXT,
  picked           INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_recall_samples_day ON recall_samples(day_key, mode);
-- 老表补列（已存在会抛，用 wrangler 跑时逐条执行；DDL 幂等由代码侧 ALTER 兜底）
-- ALTER TABLE recall_samples ADD COLUMN select_ms INTEGER NOT NULL DEFAULT 0;
-- ALTER TABLE recall_samples ADD COLUMN covered INTEGER NOT NULL DEFAULT 0;
-- ALTER TABLE recall_samples ADD COLUMN uncovered INTEGER NOT NULL DEFAULT 0;
-- ALTER TABLE recall_samples ADD COLUMN selector_skipped INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS engine_cpu (
  day_key    TEXT NOT NULL,
  channel    TEXT NOT NULL,
  mode       TEXT NOT NULL,
  requests   INTEGER NOT NULL DEFAULT 0,
  us_sum     INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (day_key, channel, mode)
);
CREATE INDEX IF NOT EXISTS idx_engine_cpu_day ON engine_cpu(day_key);
