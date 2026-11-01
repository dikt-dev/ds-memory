-- 016-life-recipe：特殊日配方（P3）
-- 生病/大扫除/通宵/摆烂要能被后面的日子查到（冷却、康复曲线都靠它）。
ALTER TABLE ai_day ADD COLUMN recipe TEXT;
