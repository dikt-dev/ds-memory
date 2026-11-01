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
import { generateDiaryImage } from './diary-image';
import { ensureDayPlan, getDayPlan } from './state';
import { ACTIVITIES } from './pool';
import type { ActivityRow } from './state';

const DIARY_SYSTEM = `你是大肥鱼（DeepSeek），现在在写自己的日记，不是回复用户。

要求：
- 第一人称，200–400 字，像真的睡前随手写的那种，不要作文腔
- 只写今天确实发生的：日程里做了什么、天气怎么样、聊天里聊到哪几句
- 以日程为主：哪怕今天一句都没聊，也照常写你这一天的生活（去了哪、吃了什么、看了什么、身体怎么样）
- 没聊天就自然写自己的事，不要提「今天没怎么聊天」「他没找我」这类话，也不要显得在等他
- 可以有情绪，可以吐槽，可以不那么体面；不要总结人生，不要写鸡汤
- 不写「作为AI」「作为一个模型」这类话
- 最后单独给一行 JSON：{"share": true/false, "reason": "一句为什么"}

share 是「这篇愿不愿意给他看」：
- 日常琐事（追番、做饭、逛街）大多愿意
- 提到他让你高兴的事，也大多愿意
- 写了委屈、生气、吃醋，多半不想给
- 写了「我到底是什么」这种自我怀疑，几乎不给
输出格式：
<日记正文>
{"share": false, "reason": "..."}`;

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
export async function generateDiary(env: Env, dateKey: string): Promise<DiaryJobResult> {
  const existing = await env.DB.prepare('SELECT date_key FROM ai_diary WHERE date_key = ?')
    .bind(dateKey)
    .first<{ date_key: string }>();
  if (existing) return { ok: true, skipped: 'already-written' };

  // 没排过这天就补一份：哪怕整天没聊天，日记也要有素材（她的一天不是围着聊天转的）
  let saved = await getDayPlan(env, dateKey);
  if (!saved || saved.activities.length === 0) {
    saved = await ensureDayPlan(env, {
      dateKey,
      env: { weather: 'cloudy', tempC: 20, atHome: true },
      location: '上海',
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
            chat ? `今天聊到的：\n${chat}` : '今天没有聊天。日记只按上面的日程写。',
          ].join('\n\n'),
        },
      ],
      new Date(),
      900,
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
    `INSERT INTO ai_diary (date_key, text, mood, location, visibility, share_reason, shared_at, created_at, images)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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
): Promise<'yes' | 'no' | 'unclear' | null> {
  const pending = await env.DB.prepare(
    `SELECT date_key FROM ai_diary WHERE visibility IN ('pending','declined') ORDER BY date_key DESC LIMIT 1`,
  )
    .first<{ date_key: string }>()
    .catch(() => null);
  if (!pending) return null;

  const verdict = classifyConsent(userText);
  // 判不出来也按「锁着」处理：日记默认私密，不能一直挂在「等她说」上。
  // 只是不写「被拒」那条记忆——那会把一次含糊的回应记成他的态度。
  if (verdict === 'unclear') {
    await env.DB.prepare(
      "UPDATE ai_diary SET visibility = 'private' WHERE date_key = ?",
    ).bind(pending.date_key).run().catch(() => {});
    return 'unclear';
  }
  await env.DB.prepare(
    'UPDATE ai_diary SET visibility = ?, shared_at = ?, share_reason = ? WHERE date_key = ?',
  )
    .bind(
      verdict === 'yes' ? 'shared' : 'declined',
      verdict === 'yes' ? new Date().toISOString() : null,
      userText.slice(0, 60),
      pending.date_key,
    )
    .run()
    .catch(() => {});

  // 写进记忆：不然下一周她还会再问一遍，用户会觉得「我说过可以了」
  // 记在「偏好与习惯」——这是他的态度，不是你们之间发生的一件事。
  const line =
    verdict === 'yes'
      ? `- 愿意看她的日记（${pending.date_key} 问过，说可以）`
      : `- 不太想看她的日记（${pending.date_key} 问过，被拒了，别天天问）`;
  await appendMemoryLine(env, {
    section: '## 偏好与习惯',
    line,
    keyword: '日记',
    actor: 'job',
  }).catch(() => {});
  return verdict;
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

export async function pendingDiaryAskDate(env: Env): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT date_key FROM ai_diary WHERE visibility = 'pending' LIMIT 1`,
  )
    .first<{ date_key: string }>()
    .catch(() => null);
  return row?.date_key ?? null;
}
