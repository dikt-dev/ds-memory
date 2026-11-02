-- 日记质量监控：输出有没有被截断、摘要是不是补的
ALTER TABLE ai_diary ADD COLUMN finish_reason TEXT;
ALTER TABLE ai_diary ADD COLUMN summary_source TEXT;
ALTER TABLE ai_diary ADD COLUMN text_len INTEGER;
