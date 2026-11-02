-- 当天出现的住户（{"core":"dou-bao","ambient":null}）。空着 = 那天没有住户。
ALTER TABLE ai_day ADD COLUMN people TEXT;
