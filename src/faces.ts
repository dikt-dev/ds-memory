/**
 * QQ/Worker 的 [face:名称] 标记 → emoji。
 *
 * 以前落库前直接把标记删掉：实时回复里有，聊天记录里永远没有，
 * 于是「她从不发表情」（2026-11-06）。现在转成 emoji 再入库，
 * 历史和网页都能看到；未收录的名字保留成「[名称]」，不静默丢。
 */
const FACE_EMOJI: Record<string, string> = {
  微笑: '🙂', 可爱: '🥰', 偷笑: '🤭', 呲牙: '😁', 调皮: '😜', 色: '😍', 害羞: '☺️', 得意: '😏',
  发怒: '😠', 白眼: '🙄', 撇嘴: '😒', 惊讶: '😮', 难过: '😔', 流泪: '😢', 大哭: '😭', 睡: '😴',
  困: '😪', 哈欠: '🥱', 冷汗: '😅', 抓狂: '😫', 晕: '😵', 衰: '😩', 委屈: '🥺', 快哭了: '🥹',
  可怜: '🥺', 思考: '🤔', 嘘: '🤫', 赞: '👍', 强: '👍', 弱: '👎', 踩: '👎', ok: '👌',
  胜利: '✌️', 鼓掌: '👏', 握手: '🤝', 抱拳: '🙏', 拥抱: '🤗', 爱心: '❤️', 心碎: '💔', 玫瑰: '🌹',
  凋谢: '🥀', 蛋糕: '🎂', 啤酒: '🍺', 咖啡: '☕', 饭: '🍚', 猪: '🐷', 月亮: '🌙', 太阳: '☀️',
  礼物: '🎁', 庆祝: '🎉', 烟花: '🎆', 炸弹: '💣', 刀: '🔪', 闪电: '⚡', 篮球: '🏀', 足球: '⚽',
  乒乓: '🏓', 便便: '💩', 骷髅: '💀', 差劲: '👎', no: '🙅', ok2: '👌', 叹气: '😮‍💨', 皱眉: '😖',
};

export function faceToEmoji(name: string): string | null {
  const key = name.trim();
  return FACE_EMOJI[key] ?? FACE_EMOJI[key.toLowerCase()] ?? null;
}

/** 把文本里的 [face:名称] 换成 emoji；不认识的保留成「[名称]」。 */
export function replaceFaceMarkers(text: string): string {
  return text.replace(/\[face[:：]([^\]]{1,12})\]/g, (_m, name: string) => {
    const key = String(name).trim();
    return faceToEmoji(key) ?? `[${key}]`;
  });
}
