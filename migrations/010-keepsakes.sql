-- 铭记（keepsake）：比普通长期记忆更高一级的事实。
-- 设计见 docs/memory/memory-milestones.md
CREATE TABLE IF NOT EXISTS memory_keepsakes (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  tone        TEXT NOT NULL DEFAULT 'warm',
  title       TEXT NOT NULL,
  detail      TEXT NOT NULL DEFAULT '',
  happened_at INTEGER NOT NULL,
  source      TEXT NOT NULL,
  evidence    TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'pending',
  pinned      INTEGER NOT NULL DEFAULT 1,
  title_key   TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_keepsakes_title_key ON memory_keepsakes(title_key);
CREATE INDEX IF NOT EXISTS idx_keepsakes_status ON memory_keepsakes(status, happened_at);