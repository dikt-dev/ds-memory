/**
 * App 状态页用的快照：心情 / 关系 / 记忆 / 今天 / 余额。
 *
 * 刻意模糊：状态只给一句人话（『还在生气』『挺熟的』），不给 0-100 的数值。
 * 用户要的是感觉，不是仪表盘；数字一旦精确，就会被当成可以优化的目标。
 */
import type { Env } from './types';
import { getMemory } from './memory';
import { facetsOf, loadEmotionState } from './emotion-context';
import { emptyEmotionVector, type EmotionVector } from './emotion-vector';
import { computeTemper } from './temper';
import { parseRelationValues } from './memory-maintenance';

export interface StatusLine {
  label: string;
  hint: string;
}

export interface StatusSnapshot {
  mood: StatusLine;
  relation: StatusLine;
  memory: StatusLine;
  today: StatusLine;
  balance: (StatusLine & { total: number; currency: string }) | null;
  updated_at: string;
}

function moodOf(vector: EmotionVector): StatusLine {
  const grievance = Math.max(0, vector.grievance);
  const fatigue = Math.max(0, vector.fatigue);
  const valence = vector.valence;
  if (grievance >= 45) return { label: '还在生气', hint: '这会儿别惹我' };
  if (grievance >= 20) return { label: '有点不痛快', hint: '话里可能带刺' };
  if (fatigue >= 65) return { label: '累了', hint: '没什么力气应付' };
  if (valence >= 25) return { label: '心情很好', hint: '容易心软' };
  if (valence >= 5) return { label: '还挺开心', hint: '愿意多说两句' };
  if (valence <= -20) return { label: '有点低落', hint: '不太想说话' };
  return { label: '还算平常', hint: '不冷不热' };
}

function relationOf(intimacy: number): StatusLine {
  if (intimacy >= 75) return { label: '黏得很', hint: '一天不聊就惦记' };
  if (intimacy >= 50) return { label: '很亲近', hint: '什么都愿意说' };
  if (intimacy >= 20) return { label: '挺熟的', hint: '开得起玩笑' };
  return { label: '还不太熟', hint: '礼数还在' };
}

function memoryOf(bytes: number): StatusLine {
  if (bytes >= 16000) return { label: '记得挺多', hint: '翻旧账都没问题' };
  if (bytes >= 6000) return { label: '记得不少', hint: '聊过的都还在' };
  if (bytes >= 1000) return { label: '还记着一些', hint: '刚攒起来' };
  return { label: '刚开始记', hint: '还在认识你' };
}

function todayOf(count: number): StatusLine {
  if (count >= 60) return { label: '今天聊了挺多', hint: '话头一直没断' };
  if (count >= 15) return { label: '今天聊了一阵', hint: '断断续续的' };
  if (count >= 1) return { label: '今天才说了几句', hint: '还没聊开' };
  return { label: '今天还没说话', hint: '等你开口' };
}

function balanceOf(total: number, currency: string): StatusLine & { total: number; currency: string } {
  const label = total < 5 ? '快见底了' : total < 20 ? '还够用一阵' : total < 60 ? '挺宽裕' : '够用很久';
  return { label, hint: 'DeepSeek 余额', total, currency };
}

// 北京时间的当天零点（毫秒）
function beijingDayStart(now: number): number {
  const shifted = now + 8 * 3600_000;
  const dayStart = Math.floor(shifted / 86_400_000) * 86_400_000;
  return dayStart - 8 * 3600_000;
}

async function countTodayMessages(env: Env, now: number): Promise<number> {
  try {
    const row = await env.DB
      .prepare('SELECT COUNT(*) AS c FROM messages WHERE created_ms >= ?')
      .bind(beijingDayStart(now))
      .first<{ c: number }>();
    return Number(row?.c ?? 0);
  } catch {
    return 0;
  }
}

async function fetchBalance(env: Env): Promise<(StatusLine & { total: number; currency: string }) | null> {
  const key = env.DEEPSEEK_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch('https://api.deepseek.com/user/balance', {
      headers: { authorization: `Bearer ${key}` },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      balance_infos?: Array<{ currency?: string; total_balance?: string }>;
    };
    const info = data.balance_infos?.[0];
    if (!info) return null;
    return balanceOf(Number(info.total_balance ?? 0), info.currency ?? 'CNY');
  } catch {
    return null;
  }
}

export async function getStatusSnapshot(env: Env, now = Date.now()): Promise<StatusSnapshot> {
  const [state, memory, todayCount, balance] = await Promise.all([
    loadEmotionState(env, now).catch(() => null),
    getMemory(env).catch(() => ''),
    countTodayMessages(env, now),
    fetchBalance(env),
  ]);
  const vector = state?.vector ?? emptyEmotionVector();
  const facets = facetsOf(parseRelationValues(memory));
  const temper = computeTemper({ vector, facets });
  const mood = moodOf(vector);
  return {
    mood: temper.allowRefuse
      ? { label: mood.label, hint: `${mood.hint}，这会儿不太想顺你的意` }
      : mood,
    relation: relationOf(facets.intimacy),
    memory: memoryOf(memory.length),
    today: todayOf(todayCount),
    balance,
    updated_at: new Date(now).toISOString(),
  };
}