-- 迁移 006：Phase 3 Affect Context
--
-- 用法：
--   wrangler d1 execute ds-memory-db --remote --config wrangler.local.toml \
--     --file=./migrations/006-affect-context.sql

CREATE TABLE IF NOT EXISTS affect_events (
  id                TEXT PRIMARY KEY,
  kind              TEXT NOT NULL CHECK (kind IN ('emotion','relationship')),
  type              TEXT NOT NULL,
  evidence          TEXT NOT NULL DEFAULT '',
  intensity         INTEGER,
  target            TEXT,
  delta_json        TEXT NOT NULL DEFAULT '{}',
  confidence        REAL NOT NULL DEFAULT 1,
  source_message_id INTEGER,
  created_at        INTEGER NOT NULL,
  resolved_at       INTEGER
);

CREATE INDEX IF NOT EXISTS idx_affect_events_time ON affect_events(created_at);
CREATE INDEX IF NOT EXISTS idx_affect_events_kind ON affect_events(kind, created_at);

CREATE TABLE IF NOT EXISTS attitude_snapshots (
  id              TEXT PRIMARY KEY,
  archetype       TEXT NOT NULL,
  attitude        TEXT NOT NULL,
  directives_json TEXT NOT NULL DEFAULT '[]',
  facets_json     TEXT NOT NULL DEFAULT '{}',
  emotion_json    TEXT NOT NULL DEFAULT '{}',
  policy_version  TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_attitude_snapshots_time ON attitude_snapshots(created_at);
