-- ============================================================
-- DeepSeek 长期记忆代理 · D1 表结构（v2 重构版）
-- 初始化：wrangler d1 execute ds-memory-db --remote --file=./schema.sql
-- ============================================================

-- ---------- 消息表 ----------
-- 设计要点：
--   turn_id    一轮对话的标识。用户发起的轮次 = 该 user 消息的 id；AI 主动消息 = 它自己的 id
--   turn_type  'chat'（用户发起）| 'proactive'（AI 主动）
--   reply_to_id 仅 assistant 回复用户时有值，指向对应的 user 消息；主动消息为 NULL
--   channel    消息来源渠道，便于按渠道统计与行为分析
--   proactive_kind 仅 turn_type='proactive' 时有值：morning / evening / random
CREATE TABLE IF NOT EXISTS messages (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  role              TEXT    NOT NULL CHECK (role IN ('user', 'assistant')),
  content           TEXT    NOT NULL,

  -- 轮次关系
  turn_id           INTEGER NOT NULL,
  turn_type         TEXT    NOT NULL DEFAULT 'chat'
                            CHECK (turn_type IN ('chat', 'proactive')),
  reply_to_id       INTEGER,

  -- 来源与场景
  channel           TEXT    NOT NULL DEFAULT 'web'
                            CHECK (channel IN ('web', 'astrobot', 'mobile', 'desktop', 'pet')),
  proactive_kind    TEXT    CHECK (proactive_kind IS NULL OR proactive_kind IN ('morning', 'evening', 'random')),

  -- 计费与用量（user 消息恒为 0）
  cost_rmb          REAL    NOT NULL DEFAULT 0,
  prompt_tokens     INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,

  -- 时间
  date_key          TEXT    NOT NULL,   -- 北京时间 'YYYY-MM-DD'，归档依据
  created_at        TEXT    NOT NULL,   -- 北京时间 ISO8601
  created_ms        INTEGER NOT NULL    -- epoch 毫秒，便于排序/算间隔
);

CREATE INDEX IF NOT EXISTS idx_messages_date      ON messages(date_key);
CREATE INDEX IF NOT EXISTS idx_messages_turn      ON messages(turn_id);
CREATE INDEX IF NOT EXISTS idx_messages_created   ON messages(created_ms);
CREATE INDEX IF NOT EXISTS idx_messages_type      ON messages(turn_type, created_ms);
CREATE INDEX IF NOT EXISTS idx_messages_channel   ON messages(channel, created_ms);

-- ---------- 定时任务状态（幂等） ----------
CREATE TABLE IF NOT EXISTS cron_runs (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  job_type TEXT NOT NULL,            -- 'daily_archive' | 'monthly_merge'
  target   TEXT NOT NULL,            -- 'YYYY-MM-DD' 或 'YYYY-MM'
  status   TEXT NOT NULL CHECK (status IN ('running', 'done', 'failed')),
  detail   TEXT,
  run_at   TEXT NOT NULL,
  UNIQUE(job_type, target)
);

-- ---------- AI 主动消息记录（数据库级幂等，替代 KV 标记） ----------
-- 每条主动消息占一行，UNIQUE(date_key, slot_key) 保证同一天同一时段只发一次
CREATE TABLE IF NOT EXISTS proactive_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  date_key   TEXT    NOT NULL,
  slot_key   TEXT    NOT NULL,   -- 'morning' | 'evening' | 'random-0' | 'random-1'
  kind       TEXT    NOT NULL,   -- 'morning' | 'evening' | 'random'
  message_id INTEGER,            -- 关联 messages.id
  -- sent   = 直连模式，已确认送达
  -- queued = 队列模式，仅代表已入队（真正的送达要等插件 ack）
  -- failed = 投递失败
  status     TEXT    NOT NULL CHECK (status IN ('sent', 'queued', 'failed')),
  detail     TEXT,
  created_at TEXT    NOT NULL,
  UNIQUE(date_key, slot_key)
);

CREATE INDEX IF NOT EXISTS idx_proactive_date ON proactive_log(date_key);

-- ---------- 主动消息质量反馈（发出后 2 小时内用户是否回复） ----------
CREATE TABLE IF NOT EXISTS proactive_feedback (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id     INTEGER NOT NULL,
  replied        INTEGER NOT NULL CHECK (replied IN (0, 1)),
  reply_after_ms INTEGER,          -- 用户回复距主动消息的毫秒数
  kind           TEXT    NOT NULL, -- morning | evening | random | unknown
  date_key       TEXT    NOT NULL,
  created_at     TEXT    NOT NULL,
  UNIQUE(message_id)
);

CREATE INDEX IF NOT EXISTS idx_feedback_created ON proactive_feedback(created_at);

-- ---------- 主动消息外发队列（AstrBot 反向轮询） ----------
CREATE TABLE IF NOT EXISTS proactive_queue (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  content    TEXT    NOT NULL,
  created_at TEXT    NOT NULL,
  sent_at    TEXT,                      -- NULL = 待发送（ISO8601 北京时间，带 T 和 +08:00）
  attempts   INTEGER NOT NULL DEFAULT 0,
  message_id INTEGER,                   -- 关联 messages.id（便于追踪）
  leased_at  TEXT                       -- 拉取占位的租约时间；NULL = 未被任何客户端取走
);

CREATE INDEX IF NOT EXISTS idx_proactive_pending ON proactive_queue(sent_at, id);
CREATE INDEX IF NOT EXISTS idx_proactive_queue_msg ON proactive_queue(message_id);

-- ---------- 运行时状态（Phase 1：替代高频 KV） ----------
CREATE TABLE IF NOT EXISTS runtime_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_runtime_state_expires
  ON runtime_state(expires_at);

-- 无状态鉴权的吊销表：scope='global' 表示全部登出
CREATE TABLE IF NOT EXISTS auth_revocations (
  scope      TEXT PRIMARY KEY,
  revoked_at INTEGER NOT NULL
);

-- ---------- Memory Context：事实 / 事件 / 摘要 / chunk 索引（Phase 2） ----------
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

-- 可重试的记忆任务（Phase 2B）：每日归档后异步补摘要/来源
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

-- ---------- Affect Context：事件账本 + 态度快照（Phase 3） ----------
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

-- Phase 5 观察：按天聚合 shadow/next 指标（不记录正文）
CREATE TABLE IF NOT EXISTS engine_metrics (
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

CREATE INDEX IF NOT EXISTS idx_engine_metrics_day ON engine_metrics(day_key);

-- 网页 TTS 任务：手机客户端优先合成，Worker MeloTTS 兜底
CREATE TABLE IF NOT EXISTS tts_jobs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  text        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',
  audio_key   TEXT,
  attempts    INTEGER NOT NULL DEFAULT 0,
  lease_until TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tts_jobs_status ON tts_jobs(status, id);

-- ---------- 记忆条目索引（可重建，memory.md/archive.md 是本体） ----------
CREATE TABLE IF NOT EXISTS memory_entries (
  id          TEXT PRIMARY KEY,
  section     TEXT NOT NULL,
  content     TEXT NOT NULL,
  date        TEXT,
  importance  INTEGER NOT NULL DEFAULT 2,
  tags        TEXT NOT NULL DEFAULT '[]',
  keywords    TEXT NOT NULL DEFAULT '[]',
  vec         TEXT,                     -- JSON number[]（embedding，可为 NULL → 关键词召回）
  source      TEXT NOT NULL DEFAULT 'memory',  -- memory | archive
  -- 语义去重指针：指向内容更详细的主条目；NULL = 自己就是主条目（召回视图用，本体不动）
  dup_of      TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_entries_section ON memory_entries(section);
CREATE INDEX IF NOT EXISTS idx_memory_entries_date ON memory_entries(date);

-- ---------- 时间金字塔摘要（周/月，条目索引的压缩视图） ----------
CREATE TABLE IF NOT EXISTS memory_rollups (
  id          TEXT PRIMARY KEY,        -- week:YYYY-MM-DD（周一） / month:YYYY-MM
  level       TEXT NOT NULL,           -- week | month
  period      TEXT NOT NULL,
  content     TEXT NOT NULL,
  entry_count INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_rollups_period ON memory_rollups(period);

CREATE INDEX IF NOT EXISTS idx_memory_entries_dup ON memory_entries(dup_of);
