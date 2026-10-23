-- 迁移 001：主动消息队列的可靠性修复
--
-- 背景（审查发现的问题）：
--   1) takePending 只 SELECT 不占位 → 两个客户端（或手动推送与轮询并发）
--      会拿到同一批消息，导致用户收到重复内容。
--   2) proactive_log 的 status 只有 sent/failed，队列模式下「入队成功」
--      被记成 sent，掩盖了「其实没人拉取」的事实。
--   3) cleanupQueue 用 `sent_at < datetime('now','-30 days')`，
--      而 sent_at 是 `2026-10-23T10:49:00+08:00` 形式，
--      字符串比较时 'T'(0x54) > ' '(0x20)，条件永远不成立 → 表无限增长。
--
-- 本迁移解决 1) 和 2)；3) 是纯代码问题，已在 queue.ts 里改为传参比较。
--
-- 用法：
--   wrangler d1 execute ds-memory-db --remote --config wrangler.local.toml \
--     --file=./migrations/001-proactive-reliability.sql
--
-- 注意：SQLite 的 ALTER TABLE 不支持 IF NOT EXISTS，
-- 重复执行会报 duplicate column，说明已迁移过，属正常。

-- ① 拉取占位：记录「谁在什么时候取走了」，租约期内不会被第二个调用者拿到
ALTER TABLE proactive_queue ADD COLUMN leased_at TEXT;

CREATE INDEX IF NOT EXISTS idx_proactive_lease
  ON proactive_queue(sent_at, leased_at, id);

-- ② proactive_log 允许 queued 状态
--    SQLite 不能直接改 CHECK 约束，只能重建表。
--    先建新表 → 搬数据 → 删旧表 → 改名 → 重建索引。
PRAGMA foreign_keys = OFF;

CREATE TABLE proactive_log_new (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  date_key   TEXT    NOT NULL,
  slot_key   TEXT    NOT NULL,
  kind       TEXT    NOT NULL,
  message_id INTEGER,
  status     TEXT    NOT NULL CHECK (status IN ('sent', 'queued', 'failed')),
  detail     TEXT,
  created_at TEXT    NOT NULL,
  UNIQUE(date_key, slot_key)
);

INSERT INTO proactive_log_new (id, date_key, slot_key, kind, message_id, status, detail, created_at)
SELECT id, date_key, slot_key, kind, message_id, status, detail, created_at
  FROM proactive_log;

DROP TABLE proactive_log;

ALTER TABLE proactive_log_new RENAME TO proactive_log;

CREATE INDEX IF NOT EXISTS idx_proactive_date ON proactive_log(date_key);

PRAGMA foreign_keys = ON;
