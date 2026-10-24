-- 迁移 004：Phase 2 Memory Context 表
--
-- 用法：
--   wrangler d1 execute ds-memory-db --remote --config wrangler.local.toml \
--     --file=./migrations/004-memory-context.sql
--
-- 说明：全部 IF NOT EXISTS，可重复执行；不修改旧表。

CREATE TABLE IF NOT EXISTS memory_facts (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL DEFAULT 'owner',
  section            TEXT NOT NULL,
  content            TEXT NOT NULL,
  subject            TEXT,
  predicate          TEXT,
  object             TEXT,
  valid_from         TEXT,
  valid_to           TEXT,
  confidence         REAL NOT NULL DEFAULT 1,
  source_message_ids TEXT NOT NULL DEFAULT '[]',
  tags               TEXT NOT NULL DEFAULT '[]',
  content_hash       TEXT NOT NULL,
  origin             TEXT NOT NULL DEFAULT 'legacy',
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_facts_section ON memory_facts(section);
CREATE INDEX IF NOT EXISTS idx_memory_facts_valid ON memory_facts(valid_to, section);
CREATE INDEX IF NOT EXISTS idx_memory_facts_hash ON memory_facts(content_hash);

CREATE TABLE IF NOT EXISTS memory_events (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL DEFAULT 'owner',
  section            TEXT NOT NULL,
  date_key           TEXT NOT NULL,
  summary            TEXT NOT NULL,
  participants       TEXT NOT NULL DEFAULT '',
  emotions           TEXT NOT NULL DEFAULT '',
  source_message_ids TEXT NOT NULL DEFAULT '[]',
  content_hash       TEXT NOT NULL,
  origin             TEXT NOT NULL DEFAULT 'legacy',
  created_at         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_events_date ON memory_events(date_key);
CREATE INDEX IF NOT EXISTS idx_memory_events_section ON memory_events(section);

CREATE TABLE IF NOT EXISTS memory_summaries (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL DEFAULT 'owner',
  level      TEXT NOT NULL CHECK (level IN ('day','week','month')),
  period     TEXT NOT NULL,
  content    TEXT NOT NULL,
  source_ids TEXT NOT NULL DEFAULT '[]',
  origin     TEXT NOT NULL DEFAULT 'legacy',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_summaries_period ON memory_summaries(level, period);

CREATE TABLE IF NOT EXISTS memory_chunks (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL DEFAULT 'owner',
  source       TEXT NOT NULL CHECK (source IN ('fact','event','summary')),
  source_id    TEXT NOT NULL,
  section      TEXT NOT NULL,
  content      TEXT NOT NULL,
  date         TEXT,
  keywords     TEXT NOT NULL DEFAULT '[]',
  tags         TEXT NOT NULL DEFAULT '[]',
  importance   INTEGER NOT NULL DEFAULT 2,
  vec          TEXT,
  content_hash TEXT NOT NULL,
  origin       TEXT NOT NULL DEFAULT 'legacy',
  updated_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_chunks_source ON memory_chunks(source, source_id);
CREATE INDEX IF NOT EXISTS idx_memory_chunks_date ON memory_chunks(date);
