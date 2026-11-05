/**
 * 千问（百炼）的余额与花费。
 *
 * 两个来源，优先级不同：
 *   1. 真实余额：百炼走阿里云账户，只能查 BSS 的 QueryAccountBalance，
 *      需要阿里云 AccessKey（RAM 用户 + 只读账单权限）。配了才显示。
 *   2. 本地花费：chat_usage 表里逐条记的 cost_rmb，永远可用。
 *
 * 没有 AccessKey 时不编数字——只显示我们自己记账的消耗，并说明原因。
 */
import { dateKeyInBeijing } from './date';
import { ensureUsageTable } from './usage-stats';
import type { Env } from './types';

export interface QwenBalance {
  /** 配了 AccessKey 才能查真实余额 */
  configured: boolean;
  /** 阿里云账户余额（元）；查不到就是 null */
  total: number | null;
  currency: string;
  spent30d: number;
  spentToday: number;
  calls30d: number;
  /** 给界面用的一句话 */
  label: string;
  hint: string;
}

const BSS_ENDPOINT = 'https://business.aliyuncs.com/';

function percentEncode(v: string): string {
  return encodeURIComponent(v)
    .replace(/\*/g, '%2A')
    .replace(/%7E/g, '~')
    .replace(/!/g, '%21')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29');
}

async function hmacSha1Base64(secret: string, text: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

/** 阿里云 BSS：查账户余额。没配 AccessKey 或调用失败都返回 null（不抛）。 */
export async function fetchAliyunBalance(env: Env): Promise<number | null> {
  const id = env.ALIYUN_ACCESS_KEY_ID?.trim();
  const secret = env.ALIYUN_ACCESS_KEY_SECRET?.trim();
  if (!id || !secret) return null;
  const params: Record<string, string> = {
    Action: 'QueryAccountBalance',
    Format: 'JSON',
    Version: '2017-12-14',
    AccessKeyId: id,
    SignatureMethod: 'HMAC-SHA1',
    SignatureVersion: '1.0',
    SignatureNonce: crypto.randomUUID(),
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
  const canonical = Object.keys(params)
    .sort()
    .map((k) => `${percentEncode(k)}=${percentEncode(params[k]!)}`)
    .join('&');
  const stringToSign = `GET&%2F&${percentEncode(canonical)}`;
  const signature = await hmacSha1Base64(secret + '&', stringToSign).catch(() => null);
  if (!signature) return null;
  const url = `${BSS_ENDPOINT}?Signature=${percentEncode(signature)}&${canonical}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const json = (await res.json()) as { Data?: { AvailableAmount?: string; Currency?: string } };
    const amount = Number(json.Data?.AvailableAmount);
    return Number.isFinite(amount) ? amount : null;
  } catch {
    return null;
  }
}

/** 从 chat_usage 汇总最近 N 天的花费。 */
export async function readQwenSpend(
  env: Env,
  days = 30,
): Promise<{ spent: number; spentToday: number; calls: number }> {
  const today = dateKeyInBeijing();
  const cutoff = dateKeyInBeijing(new Date(Date.now() - Math.max(0, days - 1) * 86400000));
  try {
    await ensureUsageTable(env);
    const row = await env.DB.prepare(
      `SELECT
         COALESCE(SUM(cost_rmb), 0) AS spent,
         COALESCE(SUM(calls), 0) AS calls,
         COALESCE(SUM(CASE WHEN day_key = ? THEN cost_rmb ELSE 0 END), 0) AS today
       FROM chat_usage WHERE day_key >= ?`,
    )
      .bind(today, cutoff)
      .first<{ spent: number; calls: number; today: number }>();
    return {
      spent: Number(row?.spent ?? 0),
      spentToday: Number(row?.today ?? 0),
      calls: Number(row?.calls ?? 0),
    };
  } catch {
    return { spent: 0, spentToday: 0, calls: 0 };
  }
}

/** 千问余额 + 花费，界面直接用。 */
export async function qwenBalanceInfo(env: Env): Promise<QwenBalance> {
  const configured = Boolean(env.ALIYUN_ACCESS_KEY_ID && env.ALIYUN_ACCESS_KEY_SECRET);
  const [total, spend] = await Promise.all([fetchAliyunBalance(env), readQwenSpend(env)]);
  const money = (n: number) => `¥${n.toFixed(2)}`;
  let label: string;
  if (total !== null) {
    label = `千问 ${money(total)}`;
  } else {
    label = `千问本月 ${money(spend.spent)}`;
  }
  const hint = total !== null
    ? `阿里云账户余额 ${money(total)}｜本月已用 ${money(spend.spent)}`
    : `本月已用 ${money(spend.spent)}（约 ${spend.calls} 次调用）；余额需要配置阿里云 AccessKey 才能查`;
  return {
    configured,
    total,
    currency: 'CNY',
    spent30d: spend.spent,
    spentToday: spend.spentToday,
    calls30d: spend.calls,
    label,
    hint,
  };
}
