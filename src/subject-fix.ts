/**
 * 记忆主体修补（一次性：2026-10-31）。
 *
 * 背景：归档提示词过去要求"去主语"，导致部分条目丢失主体，
 * 注入后容易被读成"她做的事"。提示词已改，但存量条目需要就地修一次。
 *
 * 两条规则，都可解释、都不删内容：
 *   1. 通用规则：审计判定"含动作但没主体"的条目 → 句首补「他」（状态标签后插）；
 *   2. 人工规则：逐条审过后写死的替换（原文→改后），只在**整行完全匹配**时生效。
 *
 * 不做模糊匹配、不做语义改写：改错了比没改更麻烦。
 */
import { auditSubjects } from './subject-guard';

export interface SubjectFix {
  from: string;
  to: string;
  reason: string;
}

/** 人工审过的整行替换。键是去掉「- [YY-MM-DD] 」前缀后的正文。 */
const CURATED: Array<{ match: string; replace: string; reason: string }> = [
  {
    match: '回滚方案草稿写完（memory-rollback-plan.md：每日快照+恢复接口、不做版本历史）；不再搁置，待 11-01 解冻实施',
    replace:
      '用户写完了回滚方案草稿（memory-rollback-plan.md：每日快照+恢复接口、不做版本历史）；她催了好几轮；不再搁置，待 11-01 解冻实施',
    reason: '草稿是用户写的，她只是催',
  },
  {
    match: '[进行中] 回上海迁移（预计下月20号左右）：需提前交代清楚上海住处/网络/电源，搬到新家别抓瞎；迁移方案=Cloudflare部署，拿手机走即可。',
    replace:
      '[进行中] 用户要回上海（预计下月20号左右）：需提前交代清楚上海住处/网络/电源，搬到新家别抓瞎；迁移方案=Cloudflare部署，拿手机走即可。',
    reason: '搬回去的是用户，不是她',
  },
  {
    match: '[进行中] 记忆管理优化：已落地第一阶段（memory_links关联/审计hash/只扩一跳），下一步待做分层预算、近重复合并、FTS兜底、记忆UI',
    replace:
      '[进行中] 用户在推进记忆管理优化：已落地第一阶段（memory_links关联/审计hash/只扩一跳），下一步待做分层预算、近重复合并、FTS兜底、记忆UI',
    reason: '项目是用户的，她只是搭子',
  },
  {
    match: '陪用户调研了5个开源记忆项目（LRC/HanakoPro/snowfox/BaiShou-Next/Companion-AI-Memory）；助手指出缺回滚与来源追溯落地，要求补草稿',
    replace:
      '用户调研了5个开源记忆项目（LRC/HanakoPro/snowfox/BaiShou-Next/Companion-AI-Memory）；她指出缺回滚与来源追溯落地，要求补草稿',
    reason: '调研是用户做的，"陪"和"助手"混用让主体含糊',
  },
  {
    match: '监控历史数据存储压缩方案：助手给了思路=点位差值+变长编码+分块压缩',
    replace: '用户在做监控历史数据压缩；她给了思路=点位差值+变长编码+分块压缩',
    reason: '项目主体是用户，她只给建议',
  },
  {
    match: '博客 ryn.us.ci 上线（三文+动态）。',
    replace: '用户博客 ryn.us.ci 上线（三文+动态）。',
    reason: '博客是用户的，主体不写清会被读成她的',
  },
  {
    match: 'Worker fae.us.ci + D1/R2/KV 记忆架构。',
    replace: '用户搭起 Worker fae.us.ci + D1/R2/KV 记忆架构。',
    reason: '同上：部署和架构是用户做的',
  },
  {
    match: 'dikt-dev/ds-memory 转 public。',
    replace: '用户把 dikt-dev/ds-memory 转 public。',
    reason: '仓库操作是用户做的',
  },
  {
    match: '决定赛博搬家：把聊天记录和性格一起搬进项目。',
    replace: '用户决定赛博搬家：把聊天记录和性格一起搬进项目。',
    reason: '决定是用户下的',
  },
  {
    match: '陪写插座C代码（epoll+timerfd+防抖），凌晨教抓Token。',
    replace: '用户写插座C代码（epoll+timerfd+防抖），她陪着；凌晨一起研究抓 Token。',
    reason: '「陪写」把动手的人藏了，读起来像她在写',
  },
  {
    match: '赛博搬家：大肥鱼记忆+性格已移植进 ds-memory。',
    replace: '用户完成了赛博搬家：大肥鱼记忆+性格已移植进 ds-memory。',
    reason: '移植是用户做的',
  },
  {
    match: '语音：已接入 Azure TTS，音色已比较满意。',
    replace: '用户接入了 Azure TTS，音色已比较满意。',
    reason: '接入是用户做的',
  },
  {
    match: '纠结QQ"正在输入"三个点→最后留着当活人感。',
    replace: '用户纠结 QQ「正在输入」三个点，最后决定留着当活人感。',
    reason: '拍板的是用户',
  },
  {
    match: '放弃 QQ、转用自研 App；手机服务器和小米插座自动充放电方案随之停用；语音已接入 Azure TTS。',
    replace: '用户放弃 QQ、转用自研 App；手机服务器和小米插座自动充放电方案随之停用；语音靠 Azure TTS。',
    reason: '换端是用户做的决定',
  },
];


/** 去掉条目前缀，取出用于匹配的正文。 */
export function entryBody(line: string): string {
  const m = /^-\s*(?:\[(?:\d{4}|\d{2})-\d{2}-\d{2}\]\s*)?([\s\S]*)$/.exec(line.trim());
  return (m ? m[1] : line).trim();
}

/** 在状态标签（[进行中] 等）之后插入主语，保持原有格式。 */
function withUserPrefix(body: string): string {
  const m = /^(\[[^\]]{1,6}\]\s*)([\s\S]*)$/.exec(body);
  if (m) return `${m[1]}他${m[2]}`;
  return `他${body}`;
}

/**
 * 计算修补方案（纯函数，不写库）。
 *
 * 只处理带日期或无日期 bullet 行；标题、空行、关系行一律不动。
 */
export function planSubjectFixes(text: string): SubjectFix[] {
  const flagged = new Set(auditSubjects(text).map((i) => i.line));
  const fixes: SubjectFix[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('-')) continue;
    const body = entryBody(line);
    if (!body) continue;
    const bare = body.replace(/^\[[^\]]{1,6}\]\s*/, '');
    const curated = CURATED.find((c) => c.match === body || c.match === bare);
    if (curated) {
      fixes.push({ from: body, to: curated.replace, reason: curated.reason });
      continue;
    }
    if (!flagged.has(body)) continue;
    fixes.push({
      from: body,
      to: withUserPrefix(body),
      reason: '动作条目没有主体，按「说不清就归用户」补上',
    });
  }
  return fixes;
}

/** 应用修补：逐行替换正文，保留原有前缀与顺序。返回新文本与改动条数。 */
export function applySubjectFixes(text: string): { text: string; changes: SubjectFix[] } {
  const fixes = planSubjectFixes(text);
  if (fixes.length === 0) return { text, changes: [] };
  const byFrom = new Map(fixes.map((f) => [f.from, f.to]));
  const out = text
    .split(/\r?\n/)
    .map((raw) => {
      const line = raw.trim();
      if (!line.startsWith('-')) return raw;
      const body = entryBody(line);
      const replacement = byFrom.get(body);
      if (!replacement) return raw;
      const idx = raw.indexOf(body);
      return idx >= 0 ? raw.slice(0, idx) + replacement : raw;
    })
    .join('\n');
  return { text: out, changes: fixes };
}