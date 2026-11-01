-- 014-life：生活系统 P0（日程 / 弧线 / 朋友 / 日记）
-- 设计见 docs/design/ai-life-system.md §四、§5.4、§10.4。
-- 全部 IF NOT EXISTS：重复执行安全；出问题时删表即可，不影响聊天。

-- 一天一行。plan_json 存原始生成结果，便于回查和回滚。
CREATE TABLE IF NOT EXISTS ai_day (
  date_key     TEXT PRIMARY KEY,      -- 2026-11-01
  location     TEXT NOT NULL,         -- 北京 / 杭州
  at_home      INTEGER NOT NULL,      -- 1 = 在家（默认城市）
  mood_seed    REAL NOT NULL,         -- 当天基调 -1~1
  health       INTEGER NOT NULL,      -- 0~100，生病走康复曲线
  weather      TEXT NOT NULL DEFAULT '',
  temp_c       REAL NOT NULL DEFAULT 0,
  plan_json    TEXT NOT NULL,         -- 原始生成结果
  generated_at TEXT NOT NULL
);

-- 一段一段的活动。start_min/end_min 是当天第几分钟，可以超过 1440（跨午夜）。
CREATE TABLE IF NOT EXISTS ai_activity (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  date_key      TEXT NOT NULL,
  start_min     INTEGER NOT NULL,
  end_min       INTEGER NOT NULL,
  unit_id       TEXT NOT NULL,
  kind          TEXT NOT NULL,
  title         TEXT NOT NULL,        -- 《葬送的芙莉莲》第 3 集
  place         TEXT,
  interruptible INTEGER NOT NULL,
  reply_chance  REAL NOT NULL,
  mood_delta    REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_activity_day ON ai_activity(date_key, start_min);

-- 作品弧线：进度挂在作品上，不挂在「今天追番」这个动作上。
CREATE TABLE IF NOT EXISTS ai_arc (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  kind      TEXT NOT NULL,            -- series / game / trip
  key       TEXT NOT NULL,
  title     TEXT NOT NULL,
  progress  INTEGER NOT NULL,
  total     INTEGER,
  status    TEXT NOT NULL,            -- active / paused / finished
  last_at   TEXT NOT NULL,
  note      TEXT,
  UNIQUE(kind, key)
);
CREATE INDEX IF NOT EXISTS idx_ai_arc_status ON ai_arc(kind, status, last_at);

-- 朋友班底：只在她的叙述里出现，不会变成第二个聊天对象。
CREATE TABLE IF NOT EXISTS ai_people (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  model         TEXT,
  tier          TEXT NOT NULL DEFAULT 'ambient',  -- core / ambient
  relation      TEXT,
  last_contact_at TEXT
);

-- 日记：默认私密，看要问她。
CREATE TABLE IF NOT EXISTS ai_diary (
  date_key     TEXT PRIMARY KEY,
  text         TEXT NOT NULL,
  mood         REAL NOT NULL,
  location     TEXT NOT NULL,
  visibility   TEXT NOT NULL,         -- private / shared / pending
  share_reason TEXT,
  shared_at    TEXT,
  created_at   TEXT NOT NULL
);
