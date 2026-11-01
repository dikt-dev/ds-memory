/**
 * 日记的对外视图：**锁着也给人看一点基本信息**。
 *
 * 规则（用户定的）：没征得同意只能看到日期、星期、天气、在哪、身体怎么样；
 * 正文一个字都不出服务端。同意是有期限的——**只算当天**，
 * 过了那个自然日再想看，必须重新问她一次。
 *
 * 「看过一次就一直能看」会把她的日记变成一份公开档案，
 * 那和「她愿不愿意给你看」这件事就没关系了。
 */
import type { Env } from '../types';
import { beijingDateKey } from './state';

export interface DiaryListRow {
  date: string;
  weekday: string;
  weather: string | null;
  tempC: number | null;
  location: string | null;
  recipe: string | null;
  health: number | null;
  visible: boolean;
  asked: boolean;
  /** 之前同意过，但已经过期——需要重新问她 */
  expired: boolean;
  /** 她拒过一次，还可以再问 */
  declined: boolean;
  /** 只肯给看一眼：正文只出前一小段 */
  peek: boolean;
  /** 配图（R2 key）。锁着的时候不给前端，避免提前看到画面。 */
  images: string[];
}

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function weekdayOf(dateKey: string): string {
  const ms = Date.parse(dateKey + 'T00:00:00+08:00');
  if (!Number.isFinite(ms)) return '';
  return WEEK[new Date(ms).getUTCDay()] ?? '';
}

/** 这次同意还算不算数：只认「同意那天」当天。 */
export function consentFresh(sharedAt: string | null | undefined, now = new Date()): boolean {
  if (!sharedAt) return false;
  const t = Date.parse(sharedAt);
  if (!Number.isFinite(t)) return false;
  const granted = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(t));
  return granted === beijingDateKey(now);
}

/** images 是 JSON 数组字符串；坏数据不能让整页打不开。 */
function safeImages(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** 「问问她」之后多久没回话就算没问过。聊几句就到，15 分钟足够。 */
const ASK_TTL_MS = 15 * 60 * 1000;

export async function diaryList(env: Env, limit = 60, now = new Date()): Promise<DiaryListRow[]> {
  const rows = await env.DB.prepare(
    `SELECT d.date_key, d.visibility, d.shared_at, d.asked_at, d.images,
            y.weather, y.temp_c, y.location, y.recipe, y.health
       FROM ai_diary d
       LEFT JOIN ai_day y ON y.date_key = d.date_key
      ORDER BY d.date_key DESC
      LIMIT ?`,
  )
    .bind(Math.min(120, Math.max(1, limit)))
    .all<{
      date_key: string;
      visibility: string;
      shared_at: string | null;
      asked_at: string | null;
      images: string | null;
      weather: string | null;
      temp_c: number | null;
      location: string | null;
      recipe: string | null;
      health: number | null;
    }>()
    .catch(() => null);

  const stale: string[] = [];
  const list = (rows?.results ?? []).map((r) => {
    // 问出去太久没回话，就当没问过：锁回去，别一直挂着「等她说」
    const askedLongAgo =
      r.visibility === 'pending' &&
      (!r.asked_at || now.getTime() - Date.parse(r.asked_at) > ASK_TTL_MS);
    if (askedLongAgo) stale.push(r.date_key);
    const visibility = askedLongAgo ? 'private' : r.visibility;
    const fresh = visibility === 'shared' && consentFresh(r.shared_at, now);
    const peekOh = visibility === 'peek' && consentFresh(r.shared_at, now);
    return {
      date: r.date_key,
      weekday: weekdayOf(r.date_key),
      weather: r.weather,
      tempC: typeof r.temp_c === 'number' ? Math.round(r.temp_c) : null,
      location: r.location,
      recipe: r.recipe,
      health: typeof r.health === 'number' ? r.health : null,
      visible: fresh,
      peek: peekOh,
      asked: visibility === 'pending',
      declined: visibility === 'declined',
      images: safeImages(r.images),
      expired: visibility === 'shared' && !fresh,
    };
  });

  // 过期的 pending 直接落库成私密，下次读就不用再算一遍
  if (stale.length) {
    await env.DB.prepare(
      `UPDATE ai_diary SET visibility = 'private' WHERE date_key IN (${stale.map(() => '?').join(',')})`,
    )
      .bind(...stale)
      .run()
      .catch(() => {});
  }
  return list;
}

/** 单篇：锁着就只给上面那些，正文不出服务端。 */
export async function diaryOne(
  env: Env,
  date: string,
  now = new Date(),
): Promise<{ row: DiaryListRow | null; text: string | null; shareReason: string | null; peeked?: boolean }> {
  const all = await diaryList(env, 120, now);
  const row = all.find((r) => r.date === date) ?? null;
  if (!row) return { row: null, text: null, shareReason: null };
  if (!row.visible && !row.peek) return { row, text: null, shareReason: null };
  const full = await env.DB.prepare('SELECT text, share_reason FROM ai_diary WHERE date_key = ?')
    .bind(date)
    .first<{ text: string; share_reason: string | null }>()
    .catch(() => null);
  // 只肯给看一眼：只出开头一小段，剩下的留在她那儿
  if (row.peek && !row.visible) {
    const head = (full?.text ?? '').slice(0, 80).replace(/\s+$/, '');
    return { row, text: head ? head + '……' : null, shareReason: full?.share_reason ?? null, peeked: true };
  }
  return { row, text: full?.text ?? null, shareReason: full?.share_reason ?? null };
}

/** 「问问她」：标成 pending，等聊天里她回话。已经当面同意过的不重复问。 */
export async function askDiary(env: Env, date: string, now = new Date()): Promise<{ ok: boolean; asked?: boolean; already?: boolean; error?: string }> {
  const row = await env.DB.prepare('SELECT visibility, shared_at FROM ai_diary WHERE date_key = ?')
    .bind(date)
    .first<{ visibility: string; shared_at: string | null }>();
  if (!row) return { ok: false, error: '这天没写日记' };
  if (row.visibility === 'shared' && consentFresh(row.shared_at, now)) return { ok: true, already: true };
  await env.DB.prepare("UPDATE ai_diary SET visibility = 'pending', asked_at = ? WHERE date_key = ?")
    .bind(now.toISOString(), date)
    .run();
  return { ok: true, asked: true };
}
