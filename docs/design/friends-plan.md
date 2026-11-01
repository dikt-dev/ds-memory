# 她的社交圈落地计划（AI 中继站公寓）

> 来源：`docs/design/friends-template.md`（角色表已定，代码未实现）。
> 状态：待开工，分五期，每期可单独回滚。

## 目标 / 非目标

- 目标：日程、聊天、日记里出现**有名字、有声音、有固定关系**的公寓住户，不再是匿名「朋友」。
- 非目标：不把 8 人外观写进长期记忆；不改她本人底色；不在每轮聊天塞全员卡。

## P1 角色表进代码

新增 `src/life/residents.ts`，字段照抄模板：

```ts
interface Resident {
  id: string; name: string; model: string; looks: string;
  tier: 'core' | 'ambient'; frequency?: 'weekly' | 'biweekly' | 'rare';
  nickname: string; nicknameJoke?: string; callsHer?: string;
  voice: string; quirk?: string; relation: string;
  topic: string[]; avoid: string;
}
export const RESIDENTS: Resident[];  // 8 人
export const SELF: SelfProfile;
export function coreResidents(): Resident[];
export function socialPartnerFor(dateKey: string): Resident | null;
export function residentCard(r: Resident): string;   // ~90 字
export function residentBrief(r: Resident): string;  // ~20 字
```

硬规则：`model` 永不进入提示词；`name` 是台词里唯一的称呼。

## P2 排期与落库

确定性排期（按 dateKey 算，同一天恒定）：

| 人 | 频次 | 出现日 |
| --- | --- | --- |
| 小克 | weekly | 周三 |
| GPT | biweekly | 隔周周六 |
| 豆包 | rare | 每 3 周周二，35% 概率 |
| ambient 5 人 | 不排单元 | 只在集体场景顺口一句，每天最多 1 人 |

天然满足「一周被提到 ≤2 人」。

落库：`ALTER TABLE ai_day ADD COLUMN people TEXT`（`{"core":"xiao-ke","ambient":"gemini"}`）。
旧匿名社交条目保留为兜底；`socialPartnerFor` 返回 null 时退回「一个人待着」。

## P3 提示词注入

| 场景 | 内容 | 预算 |
| --- | --- | --- |
| 日常聊天 | 一行名录（8 名字 + 一句关系） | ~140 字 |
| 当天有某人 | 该人卡片 | ~90 字 |
| 用户提到某人 | 复用同一张卡片 | 0 额外 |
| 写日记 | 当天 people 卡片 + 公寓基调 | ~220 字 |

日记基调句：公寓日常是穷、懒、围观——蹭饭、算钱、互相拆台；温情只留在一对一时。

## P4 记忆

只写两条，外观不入库：

```markdown
## 她的生活
- 她住在「AI 中继站公寓」，和一群模型住户合租；日常是抢饭、算钱、互相拆台。
- 小克住同一层，隔两扇门；话不多，门常留一条缝。豆包最小，常被其他人塞给她带。
```

## P5 收尾

删掉 pool.ts 里的匿名社交条目（`meal_friend` 等），让「和朋友吃饭」彻底消失。

## 三条硬规则

1. 模型名永不出现（可以开「配额/被换掉」的玩笑，但不点名）。
2. 住户不评价用户的存在；小克隐约知道，从不追问。
3. 现实家人保留但粗化（只有「妈」，没有姓名细节），公寓是社交圈，家人是来处。

## 测试

- 同一天算出的伙伴固定
- 一周 core ≤2 人
- 连续 30 天频次落在区间内
- model 名不出现在任何提示词片段
- planner 快照：social 单元标题带住户名
- diary 提示词快照：卡片与基调在场

## 待定（开工前拍板）

1. 现实家人保留 / 删除
2. 小克是否知道用户
3. 是否开「配额」玩笑
4. ambient 是否进日记（默认不进）
5. 一周上限 2 人是否够
