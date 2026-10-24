import { describe, expect, it } from 'vitest';
import {
  elapsedMs,
  logTrace,
  resolveRequestId,
  shouldLogHttp,
  startTrace,
} from './trace';

describe('trace', () => {
  it('复用合法 request-id', () => {
    expect(resolveRequestId('abc-123-def-456')).toBe('abc-123-def-456');
  });

  it('拒绝过长/非法 request-id 并生成 UUID', () => {
    const id = resolveRequestId('bad id with spaces'.repeat(20));
    expect(id).not.toContain(' ');
    expect(id).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('空值生成 UUID', () => {
    expect(resolveRequestId(null)).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('elapsedMs 非负', () => {
    const trace = startTrace('test-12345678');
    expect(elapsedMs(trace)).toBeGreaterThanOrEqual(0);
  });

  it('只记录关键路径和错误请求', () => {
    expect(shouldLogHttp('/api/chat', 200)).toBe(true);
    expect(shouldLogHttp('/v1/chat/completions', 200)).toBe(true);
    expect(shouldLogHttp('/api/admin/stats', 200)).toBe(true);
    expect(shouldLogHttp('/api/proactive/pending', 200)).toBe(true);
    expect(shouldLogHttp('/api/history/since', 200)).toBe(false);
    expect(shouldLogHttp('/api/health', 200)).toBe(false);
    expect(shouldLogHttp('/api/history/since', 401)).toBe(true);
  });

  it('logTrace 不会因数据不可序列化而抛错', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => logTrace('test', { circular })).not.toThrow();
  });
});
