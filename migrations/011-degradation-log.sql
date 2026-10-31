-- 011：静默降级记账（审查第 8 条）
--
-- 记忆/存储出问题时业务必须降级，但降级之后要有人知道。
-- 只存「哪一天、哪个部件、多少次」，不存正文、不存时间序列。
CREATE TABLE IF NOT EXISTS degradation_log (
  day_key TEXT NOT NULL,
  component TEXT NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0,
  last_at INTEGER NOT NULL,
  PRIMARY KEY (day_key, component)
);
