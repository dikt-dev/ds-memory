/**
 * 主动消息的「现在该不该开口」——确定性判断。
 *
 * 打分器只看得见时间、待办、情绪这些硬信号，看不见"刚刚已经道过晚安"。
 * 于是 22:57 的睡前问候会在他 22:30 说完"睡了"之后再补一句，
 * 变成追着人说话。这一层补的就是这种"对话已经收尾"的语境。
 */

export interface RecentLine {
  role: string;
  content: string;
}

export interface FarewellCheck {
  closed: boolean;
  /** 命中的那句（用于日志与跳过原因）。 */
  evidence?: string;
  /** 两边都道过别（互道晚安），比单方面收尾更确定。 */
  mutual?: boolean;
}

/** 收尾信号：不要求精确语义，只要明显是在结束对话。 */
const FAREWELL =
  /(晚安|睡了|去睡|先睡|睡觉去|睡着|明天见|明天聊|明天再说|拜拜|先这样|不聊了|下线|我眯一会|撑不住了|你也早点睡|早点休息)/;

/** 只回看最近这几条。窗口拉太长会把"下午说过晚安"也算进来。 */
export const FAREWELL_LOOKBACK = 3;
/** 收尾信号的时效：超过这个时间再提，就只是回想而不是结束对话。 */
export const FAREWELL_WINDOW_MS = 3 * 3600_000;

/**
 * 判断这段对话是不是已经收尾了。
 *
 * @param lines 最近的几条消息（旧的在前）
 * @param nowMs 当前时间
 */
export function detectFarewell(
  lines: RecentLine[],
  nowMs: number,
  lastAtMs?: number | null,
): FarewellCheck {
  if (lines.length === 0) return { closed: false };
  if (lastAtMs && nowMs - lastAtMs > FAREWELL_WINDOW_MS) return { closed: false };

  const tail = lines.slice(-FAREWELL_LOOKBACK);
  const hits = tail.filter((l) => FAREWELL.test(l.content ?? ''));
  if (hits.length === 0) return { closed: false };

  const userSaid = hits.some((l) => l.role === 'user');
  const assistantSaid = hits.some((l) => l.role !== 'user');
  return {
    closed: true,
    evidence: hits[hits.length - 1].content.slice(0, 40),
    mutual: userSaid && assistantSaid,
  };
}

/** 主动消息的「上文」：上一次主动说了什么、什么时候说的。 */
export interface RecentProactive {
  content: string;
  created_at?: string | null;
}

/** ISO 字符串 → 「11-01 17:47」（按 +08:00 展示）。 */
function stamp(iso: string | null | undefined): string {
  if (!iso) return '时间未知';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '时间未知';
  const bj = new Date(d.getTime() + 8 * 3600 * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return [pad(bj.getUTCMonth() + 1), '-', pad(bj.getUTCDate()), ' ', pad(bj.getUTCHours()), ':', pad(bj.getUTCMinutes())].join('');
}

/**
 * 「最近已主动发送」渲染：带时间，模型才能判断是不是同一天、隔了多久。
 * 以前只有内容没有时间，所以 17:47 说「电影散场」，18:13 会另起一句「奶茶呢」。
 */
export function renderRecentProactive(rows: RecentProactive[]): string {
  if (!rows.length) return '（无）';
  return rows.map((m) => ['- ', stamp(m.created_at), '｜', m.content].join('')).join('\n');
}

/**
 * 距上一条主动消息不到 3 小时时，要求接着上一条说，而不是另起一个场景。
 * 返回 null 表示不需要这条约束（很久没主动发过，随便起头）。
 */
export function proactiveContinuityRule(rows: RecentProactive[], now: Date): string | null {
  const last = rows[0];
  if (!last?.created_at) return null;
  const at = new Date(last.created_at).getTime();
  if (!Number.isFinite(at)) return null;
  const gapMin = (now.getTime() - at) / 60000;
  if (gapMin < 0 || gapMin > 180) return null;
  const minutes = Math.max(1, Math.round(gapMin));
  return [
    '## 接着上一条说',
    '你 ' + minutes + ' 分钟前刚主动说过上面第一条；这一条要接着它，不要另起一个场景。',
    '规则：不换地点、不换活动、不引入新的事情；可以是补充、追问、抱怨、或者继续之前那件事。',
  ].join('\n');
}
