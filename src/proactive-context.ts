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
