/**
 * 轻量 trace：request-id + 结构化日志。
 *
 * Phase 0 只做零 schema 的可观测性：
 * - 每个请求有 X-Request-Id；
 * - 关键路径打一行 JSON，便于 Workers Logs / wrangler tail 串联；
 * - 不记录用户正文、密钥或完整记忆内容。
 *
 * Phase 1/2 再决定是否把 trace 落到 D1。
 */

export const REQUEST_ID_HEADER = 'X-Request-Id';

/** 允许客户端传入的 id 形状：UUID、trace id、短随机串。限制长度防止日志注入。 */
const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{8,80}$/;

export interface TraceMeta {
  requestId: string;
  startedAt: number;
}

/** 复用合法 request-id；否则生成 UUID。 */
export function resolveRequestId(value?: string | null): string {
  const id = (value ?? '').trim();
  if (REQUEST_ID_RE.test(id)) return id;
  return crypto.randomUUID();
}

export function startTrace(value?: string | null): TraceMeta {
  return { requestId: resolveRequestId(value), startedAt: Date.now() };
}

export function elapsedMs(trace: TraceMeta): number {
  return Math.max(0, Date.now() - trace.startedAt);
}

/**
 * 后台任务（cron）专用：没有 requestId，但同样要结构化。
 * 前缀 `[job]` 便于和 `[trace]` 分开过滤。
 */
export function logJob(event: string, data: Record<string, unknown> = {}): void {
  try {
    console.log(`[job] ${JSON.stringify({ event, ts: new Date().toISOString(), ...data })}`);
  } catch {
    console.log(`[job] ${event}`);
  }
}

/** 结构化日志：统一前缀 + JSON，方便按 requestId 过滤。 */
export function logTrace(event: string, data: Record<string, unknown> = {}): void {
  try {
    console.log(`[trace] ${JSON.stringify({ event, ts: new Date().toISOString(), ...data })}`);
  } catch {
    // 日志序列化失败不能影响请求
    console.log(`[trace] ${event}`);
  }
}

/**
 * 只记录“值得看”的 HTTP 请求，避免每 20s 的 history 轮询把日志刷满。
 * 错误请求始终记录。
 */
export function shouldLogHttp(path: string, status: number): boolean {
  if (status >= 400) return true;
  if (path === '/api/chat') return true;
  if (path.startsWith('/v1/')) return true;
  if (path.startsWith('/api/proactive/')) return true;
  if (path.startsWith('/api/admin/')) return true;
  return false;
}
