-- 012：复习计数（遗忘曲线 + 突然想起来）
--
-- 原来只有单向衰减：只看日期，不看"这条被想起过多少次"。
-- 人靠复述抵抗遗忘，系统也要有这条反馈路径。
ALTER TABLE memory_chunks ADD COLUMN use_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE memory_chunks ADD COLUMN last_used_at INTEGER;
