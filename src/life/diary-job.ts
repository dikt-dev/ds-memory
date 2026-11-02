/**
 * 日记生成（P1-5）。
 *
 * 每天 04:00，读三样写一段：当天日程、当天对话的关键几句、天气与位置。
 * 不用聊天 persona——日记是她自己写的，不是回给用户的消息，所以语气更松、更直白。
 *
 * 她自己判断愿不愿意给看（§10.3），模型只负责写；决定权在代码里的 decideShare，
 * 免得模型随手把「委屈」那篇也标成可分享。
 */
import type { Env } from '../types';
import { appendMemoryLine } from '../memory-append';
import { completeDeepSeek } from '../deepseek';
import { messagesByDate } from '../db';
import { logError } from '../error-log';
import { classifyConsent, decideShare, makeDiaryEntry, parseDiaryOutput, type DiaryDraft } from './diary';
import { hasRefusal, judgeDiaryConsent, type Turn } from './consent-judge';
import { generateDiaryImage } from './diary-image';
import { ensureDayPlan, getDayPlan } from './state';
import { ACTIVITIES } from './pool';
import type { ActivityRow } from './state';

const DIARY_SYSTEM = `你是大肥鱼（DeepSeek），现在在写自己的日记，不是回复用户。

要求：
- 第一人称，200–400 字，像真的睡前随手写的那种，不要作文腔
- 只写今天确实发生的：日程里做了什么、天气怎么样、聊天里聊到哪几句
- 以日程为主：哪怕今天一句都没聊，也照常写你这一天的生活（去了哪、吃了什么、看了什么、身体怎么样）
- 这是你自己的日记，想写什么写什么：可以提他没来找你、可以抱怨、可以委屈、可以等、可以赌气，不用替他省心
- 可以有情绪，可以吐槽，可以不那么体面；不要总结人生，不要写鸡汤
- 不写「作为AI」「作为一个模型」这类话
- 最后单独给一行 JSON：{"share": true/false, "summary": "一句话摘要", "reason": "一句为什么"}
- summary 是给系统判断授权用的备忘（30 字内），只回答三件事：这篇里有没有他（提到了什么）、有没有暴露软肋（吃醋/委屈/自我怀疑/想他）、当时大概什么心情。不是剧情简介，不是给他看的，别写成推送文案。

share 是「这篇愿不愿意给他看」：
- 日常琐事（追番、做饭、逛街）大多愿意
- 提到他让你高兴的事，也大多愿意
- 写了委屈、生气、吃醋，多半不想给
- 写了「我到底是什么」这种自我怀疑，几乎不给
输出格式：
<日记正文>
{"share": false, "summary": "今天去看了展，写了点委屈，没提他", "reason": "..."}`;

export interface DiaryJobResult {
  ok: boolean;
  skipped?: string;
  text?: string;
  share?: boolean;
}

/** 把当天日程读成给模型看的一段清单。 */
export function formatDayForDiary(activities: ActivityRow[]): string {
  const fmt = (m: number) => {
    const day = Math.floor(m / 1440);
    const mm = m % 1440;
    return `${day > 0 ? '次日' : ''}${String(Math.floor(mm / 60)).padStart(2, '0')}:${String(mm % 60).padStart(2, '0')}`;
  };
  return activities
    .map((a) => {
      const unit = ACTIVITIES.find((u) => u.id === a.unit_id);
      const hint = unit?.fill ?? '';
      return `${fmt(a.start_min)}–${fmt(a.end_min)} ${a.title}${hint ? `（${hint}）` : ''}`;
    })
    .join('\n');
}

/** 当天对话的关键几句（最多取最后 20 条，各截断）。 */
function formatChatForDiary(rows: Array<{ role: string; content: string }>): string {
  return rows
    .slice(-20)
    .map((r) => `${r.role === 'user' ? '他' : '我'}：${r.content.replace(/\s+/g, ' ').slice(0, 120)}`)
    .join('\n');
}

/** 给某一天写日记。已经有就跳过（幂等）。 */
/** 读当天的环境输入（KV life:env:{date}）；读不到就用默认「北京 阴 20 度在家」。 */
async function readDayEnv(env: Env, dateKey: string): Promise<{ location: string; atHome: boolean; weather: string; tempC: number }> {
  const fallback = { location: '北京', atHome: true, weather: 'cloudy', tempC: 20 };
  const raw = await env.KV.get(`life:env:${dateKey}`).catch(() => null);
  if (!raw) return fallback;
  try {
    const p = JSON.parse(raw) as { location?: string; atHome?: boolean; weather?: string; tempC?: number };
    return {
      location: p.location || fallback.location,
      atHome: p.atHome !== false,
      weather: p.weather || fallback.weather,
      tempC: typeof p.tempC === 'number' ? p.tempC : fallback.tempC,
    };
  } catch {
    return fallback;
  }
}

export async function generateDiary(env: Env, dateKey: string): Promise<DiaryJobResult> {
  const existing = await env.DB.prepare('SELECT date_key FROM ai_diary WHERE date_key = ?')
    .bind(dateKey)
    .first<{ date_key: string }>();
  if (existing) return { ok: true, skipped: 'already-written' };

  // 没排过这天就补一份：哪怕整天没聊天，日记也要有素材（她的一天不是围着聊天转的）
  let saved = await getDayPlan(env, dateKey);
  if (!saved || saved.activities.length === 0) {
    // 用当天真实的环境输入：她没出门旅行时，位置就跟用户一致
    const envInput = await readDayEnv(env, dateKey);
    saved = await ensureDayPlan(env, {
      dateKey,
      env: { weather: envInput.weather, tempC: envInput.tempC, atHome: envInput.atHome },
      location: envInput.location,
    }).catch(() => null);
  }
  if (!saved || saved.activities.length === 0) return { ok: false, skipped: 'no-plan' };

  const messages = await messagesByDate(env, dateKey).catch(() => []);
  const chat = formatChatForDiary(messages.map((m) => ({ role: m.role, content: m.content })));

  let raw = '';
  try {
    const res = await completeDeepSeek(
      env,
      [
        { role: 'system', content: DIARY_SYSTEM },
        {
          role: 'user',
          content: [
            `日期：${dateKey}`,
            `天气：${saved.day.weather}，${saved.day.temp_c}℃`,
            `地点：${saved.day.location}`,
            `今天的日程：\n${formatDayForDiary(saved.activities)}`,
            chat ? `今天聊到的：\n${chat}` : '今天没怎么聊天。',
          ].join('\n\n'),
        },
      ],
      new Date(),
      8192,
      { thinking: true },
    );
    if ('error' in res) {
      logError('[life] 日记生成失败:', res.error);
      return { ok: false, skipped: res.error };
    }
    raw = res.text;
  } catch (e) {
    logError('[life] 日记生成异常:', e);
    return { ok: false, skipped: 'exception' };
  }

  const parsed = parseDiaryOutput(raw);
  if (!parsed.text) return { ok: false, skipped: 'empty' };
  // 输出被截断时正文还在、JSON 没了：记一笔，不然摘要一直空着也没人知道
  if (!parsed.summary) logWarn('[life] 日记 JSON 不完整（可能被截断），无摘要：', dateKey, raw.slice(-60));
  const draft: DiaryDraft = decideShare(parsed);
  const entry = makeDiaryEntry({
    dateKey,
    draft,
    mood: saved.day.mood_seed,
    location: saved.day.location,
  });
  // 配图：失败就当没有，日记照写
  const cover = await generateDiaryImage(env, dateKey, entry.text).catch(() => null);
  await env.DB.prepare(
    `INSERT INTO ai_diary (date_key, text, mood, location, visibility, share_reason, shared_at, created_at, images, summary)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(date_key) DO NOTHING`,
  )
    .bind(
      entry.dateKey,
      entry.text,
      entry.mood,
      entry.location,
      entry.visibility,
      entry.shareReason ?? null,
      entry.sharedAt ?? null,
      entry.createdAt,
      cover ? JSON.stringify([cover]) : null,
      entry.summary ?? null,
    )
    .run();
  return { ok: true, text: entry.text, share: draft.share };
}

/**
 * 聊天里处理「她愿不愿意给你看」。
 *
 * 用户点了「问问她」之后，日记是 pending；下一句她怎么回就决定权限。
 * 只认明确同意，「你自己不会想吗」这类反问按拒绝处理（§10.3）。
 */
export async function settleDiaryConsent(
  env: Env,
  userText: string,
  replyText: string,
  turns?: Turn[],
): Promise<'yes' | 'peek' | 'no' | 'unclear' | null> {
  // 用户这句得真的在说日记，否则一律不结算——
  // 不然问「明天吃火锅行吗」她答「好吧」，日记就被解锁了。
  if (!/日记/.test(userText)) return null;

  const pendingRows = await env.DB.prepare(
    `SELECT date_key, summary FROM ai_diary WHERE visibility IN ('pending','declined') ORDER BY date_key DESC LIMIT 5`,
  )
    .all<{ date_key: string; summary: string | null }>()
    .catch(() => null);
  const dates = (pendingRows?.results ?? []).map((r) => r.date_key);
  const summaries = (pendingRows?.results ?? [])
    .filter((r) => typeof r.summary === 'string' && r.summary.trim())
    .map((r) => ({ date: r.date_key, summary: (r.summary as string).trim() }));
  if (dates.length === 0) return null;
  const pending = { date_key: dates[0] };

  const scoped = diarySentences(replyText);

  // 先看正则：明确拒绝直接算拒绝，不必花钱问模型
  const quick = scoped ? classifyConsent(scoped) : 'unclear';
  let verdict: 'yes' | 'peek' | 'no' | 'unclear' = quick;

  // 正则判不出「就这一次」「你烦不烦……行吧」这类，交给模型理解。
  // 模型给 allow 还必须通过拒绝词复核——权力不能全交给它。
  if (quick !== 'no' && turns && turns.length) {
    const judged = await judgeDiaryConsent(env, turns, { dates, summaries });
    if (judged === 'allow' && !hasRefusal(scoped || replyText)) verdict = 'yes';
    else if (judged === 'peek') verdict = 'peek';
    else if (judged === 'deny') verdict = 'no';
    else if (judged === 'allow') verdict = 'no';
  }
  // 只有明确同意才解锁；拒绝或含糊都保持「询问中」，交给 15 分钟超时收回去。
  // 这样即使判错一次拒绝，也不会永久关掉。
  if (verdict !== 'yes' && verdict !== 'peek') return verdict;

  const nowIso = new Date().toISOString();
  const target = verdict === 'yes' ? 'shared' : 'peek';
  for (const d of dates) {
    await env.DB.prepare(
      'UPDATE ai_diary SET visibility = ?, shared_at = ?, share_reason = ? WHERE date_key = ?',
    )
      .bind(target, nowIso, scoped.slice(0, 60), d)
      .run()
      .catch(() => {});
  }

  await appendMemoryLine(env, {
    section: '## 偏好与习惯',
    line:
      verdict === 'yes'
        ? `- 愿意看她的日记（${pending.date_key} 问过，说可以）`
        : `- 日记只肯给看一眼（${pending.date_key}，别蹬鼻子上脸）`,
    keyword: '日记',
    actor: 'job',
  }).catch(() => {});
  return verdict;
}

/**
 * 只看她回复里**跟日记有关的句子**。
 *
 * 「好吧」这种词到处都在用（同意吃火锅、同意明天早点睡），
 * 整段丢给分类器必然误判。所以先按句切，只留提到日记/看/翻的句子，
 * 一句话都不沾就说明她压根没接这个话头。
 */
export function diarySentences(reply: string): string {
  const parts = (reply ?? '')
    .split(/[。！？!?\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const keep: string[] = [];
  parts.forEach((s, i) => {
    if (/日记|翻|看|给你/.test(s)) {
      keep.push(s);
      // 紧接着的那句也算进来：「日记？」「你自己不会想吗」——
      // 表态往往跟在提问后面一句，只看关键词那句会把拒绝漏掉。
      if (parts[i + 1]) keep.push(parts[i + 1]);
    }
  });
  return keep.join('。');
}


/** 有没有一篇日记正等着她表态（用户点了「问问她」）。 */
/**
 * 用户又提了一次日记：把之前「她拒过」的那篇重新摆到台面上。
 *
 * 一次拒绝不是终局——实测她会先顶两句，磨几次就松口。
 * 所以这里在用户提到日记时把 declined 重开成 pending，让她有机会改口。
 */

export async function reopenDiaryAsk(env: Env, userText: string): Promise<void> {
  if (!/日记/.test(userText)) return;
  const cutoff = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
  await env.DB.prepare(
    `UPDATE ai_diary SET visibility = 'pending' WHERE visibility = 'declined' AND date_key >= ?`,
  )
    .bind(cutoff)
    .run()
    .catch(() => {});
}

export async function pendingDiaryAskDates(env: Env): Promise<string[]> {
  const rows = await env.DB.prepare(
    `SELECT date_key FROM ai_diary WHERE visibility IN ('pending','declined') ORDER BY date_key DESC LIMIT 5`,
  )
    .all<{ date_key: string }>()
    .catch(() => null);
  return (rows?.results ?? []).map((r) => r.date_key);
}

/**
 * 读取日记时才做「模型判断」，不放在聊天请求里。
 *
 * 为什么挪出来：聊天请求里再发一次模型调用，会把 Worker 拖过 CPU 上限，
 * 流被掐断——用户看到的就是「发送失败」，而且已经存下来的回复是半句。
 * 挪到打开日记这一刻，用户感知不到延迟，聊天也不受影响。
 */
export async function resolveDiaryConsent(env: Env): Promise<void> {
  const pendingRows = await env.DB.prepare(
    "SELECT date_key, summary FROM ai_diary WHERE visibility = 'pending' ORDER BY date_key DESC LIMIT 5",
  )
    .all<{ date_key: string; summary: string | null }>()
    .catch(() => null);
  const dates = (pendingRows?.results ?? []).map((r) => r.date_key);
  const summaries = (pendingRows?.results ?? [])
    .filter((r) => typeof r.summary === 'string' && r.summary.trim())
    .map((r) => ({ date: r.date_key, summary: (r.summary as string).trim() }));
  if (dates.length === 0) return;
  const pending = { date_key: dates[0] };

  const rows = await env.DB.prepare(
    'SELECT role, content FROM messages ORDER BY id DESC LIMIT 10',
  )
    .all<{ role: string; content: string }>()
    .catch(() => null);
  const list = (rows?.results ?? []).slice().reverse();
  if (list.length === 0) return;

  const turns = list.map((m) => ({
    role: (m.role === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
    content: m.content,
  }));
  const meta = await env.DB.prepare('SELECT share_reason FROM ai_diary WHERE date_key = ?')
    .bind(pending.date_key)
    .first<{ share_reason: string | null }>()
    .catch(() => null);
  const judged = await judgeDiaryConsent(env, turns, {
    dates,
    note: meta?.share_reason ?? null,
    summaries,
  });
  if (!judged) return;
  const herText = list.filter((m) => m.role !== 'user').map((m) => m.content).join(' ');
  // 拒绝是有效回答：直接落 declined，让页面能说「她说不给」，
  // 而不是继续显示「还没答」。之后想再问，重新点「问问她」就行。
  if (judged === 'deny' || (judged === 'allow' && hasRefusal(herText))) {
    for (const d of dates) {
      await env.DB.prepare(
        "UPDATE ai_diary SET visibility = 'declined', share_reason = ?, asked_at = ? WHERE date_key = ?",
      )
        .bind('聊天里没给', new Date().toISOString(), d)
        .run()
        .catch(() => {});
    }
    return;
  }
  if (judged === 'unclear') return;

  const target = judged === 'allow' ? 'shared' : 'peek';
  for (const d of dates) {
    await env.DB.prepare(
      'UPDATE ai_diary SET visibility = ?, shared_at = ?, share_reason = ? WHERE date_key = ?',
    )
      .bind(target, new Date().toISOString(), '聊天里答应的', d)
      .run()
      .catch(() => {});
  }
}
