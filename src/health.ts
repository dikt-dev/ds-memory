/**
 * 记忆健康分（ADR-001 S7）。
 *
 * 关键原则：**判据必须在模型之外**。让 AI 自己定标准自己打分，它一定会
 * 收敛到"分好拿"的路上。这里的输入全是外部事实：召回有没有命中、
 * 用户有没有说"你忘了"、延迟有没有爆。
 */
import type { Env } from './types';
import { readDegradations, totalDegradations } from './degradations';

export interface HealthSignals {
  /** 统计天数。 */
  days: number;
  /** 召回样本数。 */
  samples: number;
  /** 至少召回出 1 条的比例（0~1）。 */
  hitRate: number;
  /** 超时比例（0~1）。 */
  timeoutRate: number;
  /** p50 / p95 延迟（毫秒）。 */
  p50Ms: number;
  p95Ms: number;
  /** 平均注入条数。 */
  avgItems: number;
  /** 用户消息里出现「忘了 / 不记得 / 记不住」的条数。 */
  forgetComplaints: number;
  /** 用户消息总数。 */
  userMessages: number;
  /** 每百条用户消息里的失忆抱怨次数。 */
  forgetPer100: number;
  /** 期间自主动作数。 */
  actions: number;
  /** 期间静默降级总次数（R2/KV/召回/嵌入…）。 */
  degradations?: number;
  /** 平均每天的降级次数。 */
  degradationsPerDay?: number;
}

export interface HealthComponent {
  name: string;
  score: number;
  weight: number;
  note: string;
}

export interface HealthResult {
  score: number;
  grade: 'good' | 'watch' | 'bad';
  components: HealthComponent[];
  signals: HealthSignals;
  warnings: string[];
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
const round = (v: number): number => Math.round(v * 100) / 100;

/**
 * 打分（纯函数）。
 *
 * 命中率 35 分：她是靠召回才记得住事的，这条最重。
 * 失忆抱怨 25 分：用户亲口说"你忘了"是最硬的质量信号。
 * 延迟 15 分：慢不致命但会伤体验。
 * 超时 15 分：超时等于这轮裸聊。
 * 静默降级 10 分：结果没坏但某个子系统在悄悄失败，只有计数能看见。
 */
export function scoreHealth(signals: HealthSignals): HealthResult {
  const components: HealthComponent[] = [];
  const warnings: string[] = [];

  // 命中率：>=90% 满分，<=50% 归零
  const hitScore = clamp01((signals.hitRate - 0.5) / 0.4) * 35;
  components.push({
    name: '召回命中率',
    score: round(hitScore),
    weight: 35,
    note: `${Math.round(signals.hitRate * 100)}% 的请求至少召回一条`,
  });

  // 失忆抱怨：每百条 0 次满分；>=5 次归零
  const forgetScore = clamp01(1 - signals.forgetPer100 / 5) * 25;
  components.push({
    name: '失忆抱怨',
    score: round(forgetScore),
    weight: 25,
    note: `每百条用户消息 ${round(signals.forgetPer100)} 次「忘了/不记得」`,
  });

  // 延迟：p95 <= 1.5s 满分，>= 4s 归零
  const latencyScore = clamp01((4000 - signals.p95Ms) / 2500) * 15;
  components.push({
    name: '召回延迟',
    score: round(latencyScore),
    weight: 15,
    note: `p50 ${signals.p50Ms}ms / p95 ${signals.p95Ms}ms`,
  });

  // 超时率：0 满分，>=5% 归零
  const timeoutScore = clamp01(1 - signals.timeoutRate / 0.05) * 15;
  components.push({
    name: '超时率',
    score: round(timeoutScore),
    weight: 15,
    note: `${round(signals.timeoutRate * 100)}% 的请求超时`,
  });

  // 降级：每天 0 次满分，>=20 次归零。它不直接伤回复，但意味着某块在坏。
  const perDay = signals.degradationsPerDay ?? 0;
  const degradationScore = clamp01(1 - perDay / 20) * 10;
  components.push({
    name: '静默降级',
    score: round(degradationScore),
    weight: 10,
    note: `平均每天 ${round(perDay)} 次降级（R2/KV/召回/嵌入等）`,
  });

  const score = round(components.reduce((sum, c) => sum + c.score, 0));

  if (signals.samples === 0) warnings.push('没有召回样本：可能是流量太低或采样没落库');
  if (signals.hitRate < 0.7) warnings.push('命中率低于 70%：召回或分块可能出了问题');
  if (signals.forgetPer100 >= 3) warnings.push('失忆抱怨偏多：她会说「忘了」说明证据没被带到');
  if (signals.timeoutRate > 0.02) warnings.push('超时率超过 2%：检查召回预算与模型延迟');
  if (signals.p95Ms > 2500) warnings.push('p95 延迟超过 2.5s：用户能感觉到卡');
  if (perDay >= 5) warnings.push(`每天 ${round(perDay)} 次静默降级：看 /api/admin/memory/degradations 定位部件`);

  const grade: HealthResult['grade'] = score >= 75 ? 'good' : score >= 50 ? 'watch' : 'bad';
  return { score, grade, components, signals, warnings };
}

// ───────────────────────── 取数 ─────────────────────────

function d1Range(days: number): { from: string; to: string } {
  const nowIso = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  const fromIso = new Date(Date.now() + 8 * 3600 * 1000 - (days - 1) * 86400000)
    .toISOString()
    .slice(0, 10);
  return { from: fromIso, to: nowIso };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

export async function loadHealth(env: Env, days = 7): Promise<HealthResult> {
  const window = Math.min(30, Math.max(1, Math.floor(days)));
  const { from, to } = d1Range(window);

  let samples: Array<{ total_ms: number; items: number; timed_out: number }> = [];
  try {
    const res = await env.DB.prepare(
      `SELECT total_ms, items, timed_out FROM recall_samples
       WHERE day_key >= ? AND day_key <= ?
       LIMIT 5000`,
    )
      .bind(from, to)
      .all<{ total_ms: number; items: number; timed_out: number }>();
    samples = res.results ?? [];
  } catch {
    samples = [];
  }

  const total = samples.length;
  const hit = samples.filter((s) => Number(s.items) > 0).length;
  const timeouts = samples.filter((s) => Number(s.timed_out) === 1).length;
  const times = samples.map((s) => Number(s.total_ms) || 0).sort((a, b) => a - b);
  const avgItems = total === 0 ? 0 : samples.reduce((sum, s) => sum + (Number(s.items) || 0), 0) / total;

  let userMessages = 0;
  let forgetComplaints = 0;
  try {
    // 分母只算用户消息：她自己的话不算"被遗忘"的机会。
    const row = await env.DB.prepare(
      `SELECT SUM(CASE WHEN role = 'user' THEN 1 ELSE 0 END) AS total,
              SUM(CASE WHEN role = 'user' AND (
                    content LIKE '%忘了%' OR content LIKE '%不记得%' OR content LIKE '%记不住%'
                  ) THEN 1 ELSE 0 END) AS forgot
       FROM messages
       WHERE date_key >= ? AND date_key <= ?`,
    )
      .bind(from, to)
      .first<{ total: number | null; forgot: number | null }>();
    userMessages = Number(row?.total) || 0;
    forgetComplaints = Number(row?.forgot) || 0;
  } catch {
    userMessages = 0;
    forgetComplaints = 0;
  }

  let actions = 0;
  try {
    const row = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM memory_actions WHERE created_at >= ?',
    )
      .bind(Date.now() - window * 86400000)
      .first<{ n: number | null }>();
    actions = Number(row?.n) || 0;
  } catch {
    actions = 0;
  }

  const degradationRows = await readDegradations(env, window);
  const degradations = totalDegradations(degradationRows);

  const signals: HealthSignals = {
    days: window,
    samples: total,
    hitRate: total === 0 ? 0 : hit / total,
    timeoutRate: total === 0 ? 0 : timeouts / total,
    p50Ms: percentile(times, 50),
    p95Ms: percentile(times, 95),
    avgItems: round(avgItems),
    forgetComplaints,
    userMessages,
    forgetPer100: userMessages === 0 ? 0 : round((forgetComplaints / userMessages) * 100),
    actions,
    degradations,
    degradationsPerDay: round(degradations / window),
  };
  return scoreHealth(signals);
}
