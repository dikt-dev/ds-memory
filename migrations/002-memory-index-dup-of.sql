-- 迁移 002：给 memory_entries 补上语义去重指针 dup_of
--
-- 背景：
--   9817c7b「语义去重」引入 memory-index.ts 的 dup_of 写入与读取，
--   但 schema.sql 里只加了注释、没有加列，导致：
--     - 新部署按 schema.sql 初始化后，reindexMemory 的 INSERT 直接报
--       "table memory_entries has no column named dup_of"；
--     - 召回索引为空，只有 3 个核心分区可用。
--
-- 用法：
--   wrangler d1 execute ds-memory-db --remote --config wrangler.local.toml \
--     --file=./migrations/002-memory-index-dup-of.sql
--
-- 注意：SQLite 的 ALTER TABLE 不支持 IF NOT EXISTS。
-- 如果提示 duplicate column name: dup_of，说明已经迁移过，属正常。

ALTER TABLE memory_entries ADD COLUMN dup_of TEXT;

CREATE INDEX IF NOT EXISTS idx_memory_entries_dup
  ON memory_entries(dup_of);
