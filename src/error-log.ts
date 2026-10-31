/**
 * 统一错误出口（审查第 7 条）。
 *
 * 原本全库 87 处 console.error，格式各异：有的带前缀、有的拼字符串、有的直接扔对象。
 * 线上没有 wrangler tail，只能靠结构化日志反查。
 *
 * 这里保持与 console.error 相同的参数形状——第一个参数约定写成 `[部件] 说明`，
 * 于是迁移是纯替换，不需要改任何调用点。
 */
type ErrorArgs = unknown[];

/** 从 `[storage] ...` 里取出部件名；取不到就记 unknown。 */
export function componentOf(args: ErrorArgs): string {
  const head = args[0];
  if (typeof head !== 'string') return 'unknown';
  const m = /^\[([a-zA-Z0-9_-]+)\]/.exec(head);
  return m ? m[1] : 'unknown';
}

/** 把 Error / 未知值变成可序列化的短字符串，避免把整个对象塞进日志。 */
export function serializeError(value: unknown): string {
  if (value instanceof Error) {
    const msg = value.message || value.name;
    return msg.length > 300 ? msg.slice(0, 300) + '…' : msg;
  }
  if (typeof value === 'string') return value.length > 300 ? value.slice(0, 300) + '…' : value;
  try {
    const json = JSON.stringify(value);
    if (!json) return String(value);
    return json.length > 300 ? json.slice(0, 300) + '…' : json;
  } catch {
    return String(value);
  }
}

/**
 * 记录一条错误。**永不抛异常**：日志写不出去不该让业务跟着挂。
 * 输出一行 JSON，字段固定：level / at / component / msg / detail。
 */
export function logError(...args: ErrorArgs): void {
  try {
    const detail = args.length > 1 ? args.slice(1).map(serializeError).join(' | ') : undefined;
    const head = typeof args[0] === 'string' ? args[0] : serializeError(args[0]);
    const line = JSON.stringify({
      level: 'error',
      at: new Date().toISOString(),
      component: componentOf(args),
      msg: head.length > 400 ? head.slice(0, 400) + '…' : head,
      ...(detail ? { detail } : {}),
    });
    console.error(line);
  } catch {
    console.error('[error-log] failed to serialize');
  }
}

/** 同上，但级别是 warn。 */
export function logWarn(...args: ErrorArgs): void {
  try {
    const detail = args.length > 1 ? args.slice(1).map(serializeError).join(' | ') : undefined;
    const head = typeof args[0] === 'string' ? args[0] : serializeError(args[0]);
    console.warn(
      JSON.stringify({
        level: 'warn',
        at: new Date().toISOString(),
        component: componentOf(args),
        msg: head.length > 400 ? head.slice(0, 400) + '…' : head,
        ...(detail ? { detail } : {}),
      }),
    );
  } catch {
    console.warn('[error-log] failed to serialize');
  }
}
