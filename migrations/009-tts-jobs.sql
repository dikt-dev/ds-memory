-- 迁移 009：网页 TTS 任务队列（手机优先，Worker 兜底）
CREATE TABLE IF NOT EXISTS tts_jobs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  text        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending', -- pending | processing | done | failed
  audio_key   TEXT,
  attempts    INTEGER NOT NULL DEFAULT 0,
  lease_until TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tts_jobs_status ON tts_jobs(status, id);
