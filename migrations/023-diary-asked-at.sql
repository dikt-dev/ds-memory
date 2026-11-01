-- 「问问她」的时间戳：太久没回话就自动锁回去，别一直挂在「等她说」
ALTER TABLE ai_diary ADD COLUMN asked_at TEXT;
