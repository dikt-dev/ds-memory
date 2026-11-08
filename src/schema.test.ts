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

  it('包含 Phase 3 的 Affect Context 表', () => {
    expect(schemaSql).toContain('CREATE TABLE IF NOT EXISTS affect_events');
    expect(schemaSql).toContain('CREATE TABLE IF NOT EXISTS attitude_snapshots');
  });

  it('包含 Phase 5 的 engine_metrics 表', () => {
    expect(schemaSql).toContain('CREATE TABLE IF NOT EXISTS engine_metrics');
  });

  it('包含 Phase 2 的 Memory Context 表', () => {
    expect(schemaSql).toContain('CREATE TABLE IF NOT EXISTS memory_facts');
    expect(schemaSql).toContain('CREATE TABLE IF NOT EXISTS memory_events');
    expect(schemaSql).toContain('CREATE TABLE IF NOT EXISTS memory_summaries');
    expect(schemaSql).toContain('CREATE TABLE IF NOT EXISTS memory_chunks');
    expect(schemaSql).toContain('CREATE TABLE IF NOT EXISTS memory_jobs');
    expect(schemaSql).toContain('CREATE TABLE IF NOT EXISTS memory_links');
    expect(schemaSql).toContain('CREATE TABLE IF NOT EXISTS memory_audit');
  });

  it('存在 dup_of 的迁移脚本（已有库升级用）', () => {
    expect(migrationSql).toContain('ADD COLUMN dup_of');
  });
});

describe('运行期建表的表也必须写进 schema.sql（新环境否则静默失效）', () => {
  it('cmid_cache / request_log / recall_samples / engine_cpu 都在 schema.sql 里', () => {
    for (const name of ['cmid_cache', 'request_log', 'recall_samples', 'engine_cpu']) {
      expect(schemaSql).toContain('CREATE TABLE IF NOT EXISTS ' + name);
    }
  });

  it('cmid_cache 有 TTL 清理需要的 created_at 索引', () => {
    expect(schemaSql).toContain('idx_cmid_cache_at');
  });

  it('recall_samples 带上计时口径修正后的列', () => {
    const table = schemaSql.slice(schemaSql.indexOf('CREATE TABLE IF NOT EXISTS recall_samples'));
    for (const col of ['select_ms', 'covered', 'uncovered', 'selector_skipped']) {
      expect(table).toContain(col);
    }
  });
});
