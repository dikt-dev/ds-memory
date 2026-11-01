#!/usr/bin/env node
/**
 * 从 docs/design/activity-pool.md 生成 src/life/pool.ts。
 *
 * 为什么不手抄：池子有 64 条，手抄必然和文档漂移，而文档才是你要改的地方。
 * 文档格式：- **id** 名称 ｜ 45–120 ｜ indoor,rainy_ok ｜ +0.2 ｜ 25% ｜ 提示
 */
import { readFileSync, writeFileSync } from 'node:fs';

const SRC = 'docs/design/activity-pool.md';
const OUT = 'src/life/pool.ts';

const KIND_BY_HEADING = [
  ['看番看剧', 'anime'],
  ['游戏', 'game'],
  ['兴趣与手工', 'hobby'],
  ['家务', 'chores'],
  ['吃饭', 'meal'],
  ['出门', 'outing'],
  ['近郊', 'short_trip'],
  ['在家躺着', 'idle'],
  ['天气', 'weather'],
  ['社交', 'social'],
];

// 连续型：这几条接昨天的进度（§5.4）
const ARC_BY_ID = {
  anime_series: 'series',
  anime_marathon: 'series',
  anime_rewatch: 'series',
  game_playthrough: 'game',
};

const md = readFileSync(SRC, 'utf8');
const lines = md.split('\n');
let kind = null;
const units = [];

for (const line of lines) {
  const heading = line.match(/^## [一二三四五六七八九十]+、(.+)/);
  if (heading) {
    const hit = KIND_BY_HEADING.find(([k]) => heading[1].includes(k));
    kind = hit ? hit[1] : null;
    continue;
  }
  const m = line.match(/^- \*\*([a-z_]+)\*\* (.+?) ｜ (\d+)–(\d+) ｜ ([^｜]+) ｜ ([+-]?[\d.]+) ｜ ([\d.]+)%[^｜]*｜ (.+)$/);
  if (!m || !kind) continue;
  const [, id, name, min, max, tagRaw, mood, chance, fill] = m;
  const tags = tagRaw.split(/[,，]/).map((t) => t.trim()).filter(Boolean);
  units.push({
    id,
    kind,
    name: name.trim(),
    min: Number(min),
    max: Number(max),
    tags,
    mood: Number(mood),
    interruptible: !line.includes('不可打断'),
    replyChance: Number(chance) / 100,
    arc: ARC_BY_ID[id],
    fill: fill.trim(),
    weight: 1,
  });
}

if (units.length < 50) {
  console.error(`只解析出 ${units.length} 条，文档格式可能变了；拒绝写文件`);
  process.exit(1);
}

const body = units
  .map((u) => {
    const parts = [
      `id: '${u.id}'`,
      `kind: '${u.kind}'`,
      `name: '${u.name}'`,
      `min: ${u.min}`,
      `max: ${u.max}`,
      `tags: [${u.tags.map((t) => `'${t}'`).join(', ')}]`,
      `mood: ${u.mood}`,
      `interruptible: ${u.interruptible}`,
      `replyChance: ${u.replyChance}`,
    ];
    if (u.arc) parts.push(`arc: '${u.arc}'`);
    parts.push(`fill: '${u.fill}'`);
    parts.push(`weight: ${u.weight}`);
    return `  { ${parts.join(', ')} },`;
  })
  .join('\n');

const out = `/**
 * 活动单元池 —— 由 scripts/gen-pool.mjs 从 docs/design/activity-pool.md 生成。
 *
 * 不要手改本文件：改文档，再跑 npm run gen:pool。
 * 生成于 ${new Date().toISOString().slice(0, 10)}，共 ${units.length} 条。
 */
import type { ActUnit } from './types';

export const ACTIVITIES: ActUnit[] = [
${body}
];

/** 按 id 索引，校验器和反重复都用得上。 */
export const BY_ID: Map<string, ActUnit> = new Map(ACTIVITIES.map((u) => [u.id, u]));
`;

writeFileSync(OUT, out, 'utf8');
const byKind = {};
for (const u of units) byKind[u.kind] = (byKind[u.kind] ?? 0) + 1;
console.log(`生成 ${units.length} 条 →`, JSON.stringify(byKind));
