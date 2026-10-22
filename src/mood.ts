/**
 * 情绪感知（纯函数）。
 *
 * 从最近对话推断用户当前状态，用于调整主动消息的时机与语气：
 * - 心情低落 → 更愿意陪伴，但语气要轻
 * - 忙碌/焦躁 → 减少打扰
 * - 开心 → 可以多聊
 *
 * 实现：关键词词典 + 强度加权（不调用 AI，零成本、可测试）。
 */

export type MoodLabel = 'low' | 'tired' | 'busy' | 'happy' | 'neutral';

export interface MoodResult {
  mood: MoodLabel;
  /** -1（很负面）~ +1（很正面） */
  valence: number;
  /** 0（平静）~ 1（强烈） */
  intensity: number;
  /** 命中的关键词（用于调试与提示词） */
  signals: string[];
  /** 该情绪下是否适合主动搭话 */
  suggestContact: boolean;
}

/** 负面情绪词（低落）。 */
const LOW_WORDS = [
  '难过', '伤心', '想哭', '哭', '崩溃', '绝望', '孤独', '寂寞', '焦虑', '压力大',
  '烦', '烦躁', '郁闷', '压抑', '失落', '沮丧', '不开心', '委屈', '累死', 'emo',
  '分手', '吵架', '被骂', '失败', '搞砸', '没意思', '不想活',
];

/** 疲惫词。 */
const TIRED_WORDS = [
  '好累', '累', '困', '熬夜', '通宵', '没睡', '失眠', '疲惫', '撑不住', '加班',
  '忙死', '顶不住', '想睡', '打瞌睡',
];

/** 忙碌词。 */
const BUSY_WORDS = [
  '忙', '赶工', 'ddl', '截止', '开会', '加班', '没空', '稍后', '待会', '在忙',
  '马上要', '来不及',
];

/** 正面情绪词（区分强弱：弱词单独出现不足以判定开心）。 */
const HAPPY_STRONG = [
  '太好了', '哈哈', '嘿嘿', '爽', '棒', '赞', '爱了', '成功', '搞定',
  '通过了', '赢了', '舒服', '满足', '兴奋', '超级开心', '超开心',
];
const HAPPY_WEAK = ['开心', '高兴', '不错', '喜欢', '期待'];

function countMatches(text: string, words: string[]): { count: number; hits: string[] } {
  let count = 0;
  const hits: string[] = [];
  for (const w of words) {
    if (text.includes(w)) {
      count += 1;
      hits.push(w);
    }
  }
  return { count, hits };
}

/**
 * 分析一段对话文本的情绪。
 * @param text 最近若干条用户消息拼接
 */
export function analyzeMood(text: string): MoodResult {
  if (!text || !text.trim()) {
    return { mood: 'neutral', valence: 0, intensity: 0, signals: [], suggestContact: true };
  }

  const low = countMatches(text, LOW_WORDS);
  const tired = countMatches(text, TIRED_WORDS);
  const busy = countMatches(text, BUSY_WORDS);
  const happyStrong = countMatches(text, HAPPY_STRONG);
  const happyWeak = countMatches(text, HAPPY_WEAK);
  // 弱正面词权重减半，避免"不错"这类词误判
  const happyScore = happyStrong.count + happyWeak.count * 0.5;

  const negScore = low.count * 2 + tired.count * 1.2 + busy.count * 0.8;
  const posScore = happyScore * 1.5;

  const valence = Math.max(-1, Math.min(1, (posScore - negScore) / 5));
  const intensity = Math.min(1, (negScore + posScore) / 6);
  const signals = [...low.hits, ...tired.hits, ...busy.hits, ...happyStrong.hits, ...happyWeak.hits].slice(0, 8);

  let mood: MoodLabel = 'neutral';
  if (low.count > 0 && low.count >= happyScore) mood = 'low';
  else if (tired.count > 0 && tired.count >= happyScore) mood = 'tired';
  else if (busy.count > 0 && busy.count > happyScore) mood = 'busy';
  // 开心需要足够强度：强词命中，或弱词累计 ≥2
  else if (happyStrong.count > 0 || happyWeak.count >= 2) mood = 'happy';

  // 是否适合主动联系
  let suggestContact = true;
  if (mood === 'low') suggestContact = true; // 低落时更需要陪伴
  else if (mood === 'busy') suggestContact = false; // 忙时别打扰
  else if (mood === 'tired' && intensity >= 0.5) suggestContact = false; // 很累时别打扰

  return { mood, valence, intensity, signals, suggestContact };
}

/** 情绪对打分的影响（返回加减分与理由）。 */
export function moodScoreAdjust(mood: MoodResult): { delta: number; reason?: string } {
  if (!mood.suggestContact) {
    return { delta: -30, reason: `用户当前${moodLabelText(mood.mood)}，不宜打扰` };
  }
  if (mood.mood === 'low' && mood.intensity >= 0.3) {
    return { delta: +20, reason: '用户情绪低落，陪伴价值高' };
  }
  if (mood.mood === 'happy' && mood.intensity >= 0.3) {
    return { delta: +10, reason: '用户心情不错，适合分享' };
  }
  return { delta: 0 };
}

export function moodLabelText(mood: MoodLabel): string {
  switch (mood) {
    case 'low': return '情绪低落';
    case 'tired': return '疲惫';
    case 'busy': return '忙碌';
    case 'happy': return '心情不错';
    default: return '平静';
  }
}

/** 情绪对生成语气的提示词片段。 */
export function moodToneHint(mood: MoodResult): string {
  switch (mood.mood) {
    case 'low':
      return '用户最近情绪不太好，语气要轻、别讲大道理，可以关心但不要追问原因。';
    case 'tired':
      return '用户最近很累，别长篇大论，简短温和即可。';
    case 'happy':
      return '用户最近心情不错，语气可以轻快一点。';
    default:
      return '';
  }
}
