/**
 * 「现在的你」——把三处状态合成一张卡。
 *
 * 之前她每轮会收到三张卡：
 *   temper.ts        → ## 这一轮的你        （愿不愿意配合）
 *   emotion-snapshot → ## 我现在的状态      （关系 / 情绪 / 芥蒂 / 一句建议）
 *   character-card   → ## 当前的小蓝        （时段 / 疲惫 / 分寸 / 倾向 / 对话方式）
 *
 * 三张卡都在回答"她现在是什么状态"，而且真的会打架：脾气说「不想配合」，
 * 情绪快照说「先接住情绪」，角色卡又说「上午状态不错，精神」——同一轮三种口径。
 *
 * 这里合成一张，只留事实与一条态度：
 *   - 情绪快照里那句通用的「这一轮：……」建议**丢掉**，因为它和脾气直接冲突；
 *   - 角色卡里的「本轮倾向」「对话方式」也丢掉：前者和脾气重复，后者与 persona / 说话段重复。
 *
 * 解析是容忍式的：传进来的不是标准卡片（比如单测里直接给一句话）时原文照留，绝不吞内容。
 */

export interface NowCardParts {
  /** 脾气：这一轮愿不愿意配合（temper.line） */
  temper?: string | null;
  /** 情绪快照（emotion-snapshot，自带 '## 我现在的状态' 标题） */
  attitude?: string | null;
  /** 角色状态卡（character-card.cardText，自带 '## 当前的XX' 标题） */
  card?: string | null;
  /** 他正在难受时的一句行为指引（来自 recentPainEvent） */
  care?: string | null;
}

interface Parsed {
  map: Map<string, string>;
  rest: string[];
}

function parse(text?: string | null): Parsed {
  const map = new Map<string, string>();
  const rest: string[] = [];
  if (!text) return { map, rest };
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    // 「- 键：值」；键最多 8 字，避免把带冒号的长句当成键
    const m = /^[-*]\s*([^：:]{1,8})[：:]\s*(.+)$/.exec(line);
    if (m) map.set(m[1].trim(), m[2].trim());
    else rest.push(line.replace(/^[-*]\s*/, ''));
  }
  return { map, rest };
}

/** 合成一张「现在的你」。 */
export function buildNowCard(parts: NowCardParts): string {
  const card = parse(parts.card);
  const mood = parse(parts.attitude);
  const out: string[] = ['## 现在的你（此刻的状态，不是固定人设）'];
  const push = (label: string, value?: string | null) => {
    if (value && value.trim()) out.push(`- ${label}：${value.trim()}`);
  };

  // 顺序：身体 → 情绪 → 关系 → 态度 → 相处 → 时间
  push('状态', card.map.get('当下状态'));
  push('刚才在做什么', card.map.get('刚才在做什么'));
  push('疲惫度', card.map.get('疲惫度'));
  push('情绪', mood.map.get('当下'));
  push('关系', mood.map.get('关系'));
  push('心里还记着', mood.map.get('心里还记着'));
  // 动机比倾向更像活人：她这一轮想做什么
  push('此刻想要', card.map.get('此刻想要'));
  push('冷落小情绪', card.map.get('冷落小情绪'));
  // 他倒苦水：先接住。和「脾气」不冲突——脾气现在不会因为他受苦而变冷
  if (parts.care?.trim()) out.push(`- 他现在在难受：${parts.care.trim()}`);
  // 脾气单独一行：它是这一轮唯一的态度来源，不再和别的卡抢解释权
  push('对你的态度', parts.temper);
  push('开场情绪', card.map.get('开场情绪'));
  push('相处分寸', card.map.get('相处分寸'));
  push('关系阶段', card.map.get('关系阶段'));
  push('这一步可以', card.map.get('这一步可以'));
  push('这一步还不行', card.map.get('这一步还不行'));
  push('距上次聊天', card.map.get('距上次聊天'));

  // 解析不到的原文照留（单测或将来改格式时不丢内容）
  for (const line of [...card.rest, ...mood.rest]) out.push(`- ${line}`);

  return out.join('\n');
}