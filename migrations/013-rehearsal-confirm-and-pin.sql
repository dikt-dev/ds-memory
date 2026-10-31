-- 013：确认制复习 + 铭记锁
--
-- confirmed_count：只有用户明确确认过（"对""记得"）的召回才算有效复习；
-- pinned：单条记忆的"不许淡忘"标记（keepsakes 是她主动珍藏的片段，这是给普通记忆上锁）。
ALTER TABLE memory_chunks ADD COLUMN confirmed_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE memory_chunks ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_memory_chunks_pinned ON memory_chunks(pinned);
