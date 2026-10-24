import { describe, expect, it } from 'vitest';
import schemaSql from '../schema.sql?raw';
import migrationSql from '../migrations/002-memory-index-dup-of.sql?raw';

describe('schema.sql 与索引代码保持一致', () => {
  it('memory_entries 必须有 dup_of（reindexMemory 会写入）', () => {
    const table = schemaSql.slice(schemaSql.indexOf('CREATE TABLE IF NOT EXISTS memory_entries'));
    expect(table).toContain('dup_of');
  });

  it('memory_entries 的语义去重列有索引', () => {
    expect(schemaSql).toContain('idx_memory_entries_dup');
  });

  it('包含 Phase 1 的 runtime_state 与 auth_revocations', () => {
    expect(schemaSql).toContain('CREATE TABLE IF NOT EXISTS runtime_state');
    expect(schemaSql).toContain('CREATE TABLE IF NOT EXISTS auth_revocations');
  });

  it('包含 Phase 2 的 Memory Context 表', () => {
    expect(schemaSql).toContain('CREATE TABLE IF NOT EXISTS memory_facts');
    expect(schemaSql).toContain('CREATE TABLE IF NOT EXISTS memory_events');
    expect(schemaSql).toContain('CREATE TABLE IF NOT EXISTS memory_summaries');
    expect(schemaSql).toContain('CREATE TABLE IF NOT EXISTS memory_chunks');
  });

  it('存在 dup_of 的迁移脚本（已有库升级用）', () => {
    expect(migrationSql).toContain('ADD COLUMN dup_of');
  });
});
