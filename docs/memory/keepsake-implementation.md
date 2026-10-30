# 铭记 K-1 ~ K-4 实施方案

> 这是给「具体怎么做」看的施工图。设计背景见 `memory-milestones.md`。

## 0. 一句话

新增一张 `memory_keepsakes` 表 → 每日归档时用规则 + v4-pro 往里写候选 → 审核通过的渲染成 `## 铭记` 一段注入稳定段 → 提供 4 个 admin 接口人工增删。

## 1. 数据层

### 1.1 迁移 `migrations/010-keepsakes.sql`

```sql
CREATE TABLE IF NOT EXISTS memory_keepsakes (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN (
                'first_meet','name','promise','milestone','custom',
                'first_fight','hurt','parting','betrayal','first_apology')),
  tone        TEXT NOT NULL DEFAULT 'warm' CHECK (tone IN ('warm','neutral','bitter')),
  title       TEXT NOT NULL,
  detail      TEXT NOT NULL DEFAULT '',
  happened_at INTEGER NOT NULL,
  source      TEXT NOT NULL CHECK (source IN ('manual','rule','ai')),
  evidence    TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  pinned      INTEGER NOT NULL DEFAULT 1,
  title_key   TEXT NOT NULL,           -- 归一化标题，用于去重
  created_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_keepsakes_title_key ON memory_keepsakes(title_key);
CREATE INDEX IF NOT EXISTS idx_keepsakes_status ON memory_keepsakes(status, happened_at);
```

`title_key` = 去掉标点、空格、统一全半角后的小写标题；比「标题相似度」更简单可靠。相似度去重留给应用层（Jaccard ≥ 0.8 视为重复，不插入）。

## 2. 模块 `src/keepsakes.ts`

```ts
export interface Keepsake {
  id: string;
  kind: KeepsakeKind;
  title: string;
  detail: string;
  happened_at: number;
  tone: 'warm' | 'neutral' | 'bitter';
  source: 'manual' | 'rule' | 'ai';
  evidence: string;
  status: 'pending' | 'approved' | 'rejected';
  pinned: number;
  created_at: number;
}

export async function ensureKeepsakesTable(env: Env): Promise<void>;
export async function loadKeepsakes(env: Env, status?: Keepsake['status']): Promise<Keepsake[]>;
export async function insertKeepsake(env: Env, input: NewKeepsake): Promise<'inserted' | 'duplicate' | 'dropped'>;
export async function setKeepsakeStatus(env: Env, id: string, status: Keepsake['status']): Promise<boolean>;
export async function setKeepsakePinned(env: Env, id: string, pinned: 0 | 1): Promise<boolean>;

/** 纯函数：渲染注入块。空数组返回空串。 */
export function renderKeepsakesBlock(items: Keepsake[], max = 30): string;

/** 规则识别：首条消息 / 取名 / 首吵 / 首和解 / 首承诺。 */
export async function detectRuleKeepsakes(env: Env, now: number): Promise<NewKeepsake[]>;

/** AI 候选：一次 v4-pro 调用，输出 JSON 候选（已校验）。 */
export async function detectAiKeepsakes(
  env: Env,
  dateKey: string,
  conversation: string,
): Promise<NewKeepsake[]>;
```

### 2.1 `renderKeepsakesBlock`

```ts
export function renderKeepsakesBlock(items: Keepsake[], max = 30, maxBitter = 8): string {
  const eligible = items
    .filter((i) => i.status === 'approved' && i.pinned === 1)
    .sort((a, b) => a.happened_at - b.happened_at);   // 早的在前：越早越沉
  const warm = eligible.filter((i) => i.tone !== 'bitter');
  const bitter = eligible.filter((i) => i.tone === 'bitter').slice(0, maxBitter);
  const picked = [...warm, ...bitter].sort((a, b) => a.happened_at - b.happened_at).slice(0, max);
  if (picked.length === 0) return '';
  const lines = [
    '## 铭记',
    '- 这些是你和他真正记住的事，好的坏的都算。不用检索，一直记得。',
  ];
  for (const it of picked) {
    const d = new Date(it.happened_at + 8 * 3600_000).toISOString().slice(0, 10);
    const suffix = it.tone === 'bitter' ? '（这件事你记得，还气不气看你现在的情绪）' : '';
    lines.push(`- ${d} ${it.title}${it.detail ? '：' + it.detail : ''}${suffix}`);
  }
  if (bitter.length > 0) {
    lines.push('- 上面带「记得」的事：别主动翻旧账，也别拿来当赢一句的武器；可以记得，也可以选择不说。');
  }
  return lines.join('\n');
}
```

体积控制：30 条 ×（日期 11 + 标题 24 + 细节 80 + 前缀）≈ 3.5 KB 最坏，正常 1.5–2 KB。实测超过 2.5 KB 就把 `detail` 截到 40 字。

### 2.2 五条规则（`detectRuleKeepsakes`）

| kind | 判定 | 数据源 |
|---|---|---|
| `first_meet` | 表里没有任何 `first_meet`，且 `messages` 有数据 | `SELECT MIN(created_ms) FROM messages` |
| `name` | memory.md `称呼与关系` 或 `人物底色` 里出现「叫/取名/名字是」的新名字 | memory.md 文本 + 上次记录 |
| `first_fight` | 没有 `first_fight`，且 `affect_events` 有未化解负向事件 | `affect_events` |
| `first_makeup` | 没有 `first_makeup`，且 apology 事件存在 | `affect_events` |
| `first_promise` | 没有 `promise`，且消息里有「以后每年/每天/答应你」 | 当天对话正则 |

规则命中的条目 `status = 'approved'`、`source = 'rule'`，直接注入。

### 2.3 AI 候选（`detectAiKeepsakes`）

```ts
const SYSTEM = `你是记忆筛选器，只做一件事：判断今天有没有值得「一辈子记住」的时刻。

算：关系层面的第一次（第一次说话/第一次吵架/第一次和好）、
她自己的事（取名、生日）、承诺与约定（以后每年这天）、他明确要求记住的、
以及真正伤到她的事（被丢下、被骂、说好的事没做到）。

不算：技术进展、工作成果、日常寒暄、天气、吃饭、一次性的请求、单纯的情绪波动、小摩擦。

只输出 JSON：{"keepsakes":[{"kind":"...","tone":"warm|neutral|bitter","title":"<=24字","detail":"<=80字","happened_at":"YYYY-MM-DD","evidence":"原话逐字"}]}
没有就输出 {"keepsakes":[]}。kind 只能取 first_meet|name|promise|milestone|custom|first_fight|hurt|parting|betrayal|first_apology。
tone=bitter 只用于真正伤到她的程度；带刺的玩笑、一时不爽、被拒绝一次，都不算。每天最多 1 条 bitter。
evidence 必须是对话里的原话片段，一个字都不能改。`;
```

调用：`deepseekChat(model = env.DISTILL_DEEPSEEK_MODEL, thinking: false, max_tokens: 800)`。
不开思考：这是分类判断，不是推理。省一半费用和延迟。

### 2.4 校验与去重（`insertKeepsake` 内部）

```ts
function validate(input: NewKeepsake, conversation: string): NewKeepsake | null {
  if (!KINDS.includes(input.kind)) return null;
  if (!TONES.includes(input.tone)) input.tone = 'neutral';
  // kind 自带极性时以 kind 为准，避免模型把 first_fight 标成 warm
  if (BITTER_KINDS.includes(input.kind)) input.tone = 'bitter';
  const title = clip(input.title, 24);
  const detail = clip(input.detail, 80);
  if (!title) return null;
  // 红线：引文必须逐字存在于当天对话
  const evidence = input.evidence && conversation.includes(input.evidence) ? input.evidence : '';
  if (input.source === 'ai' && input.evidence && !evidence) return null;
  return { ...input, title, detail, evidence };
}
```

去重：`title_key` 唯一索引兜底；插入前用 Jaccard（按字符 2-gram）比对已有标题，≥ 0.8 直接丢弃。

配额：单日 AI 入册 ≤ 2、单周 ≤ 5；其中 **bitter 单日 ≤ 1、单周 ≤ 2**；注入时 bitter 最多 8 条。超出只记日志不插入。

## 3. 注入

### 3.1 提示词

`BasePromptArgs` 加一个字段：

```ts
/** 铭记块（已渲染好的 Markdown，空串表示没有） */
keepsakes?: string | null;
```

渲染位置：`prompt.ts` 的 ② 长期记忆之后、`## 记忆怎么用` 之前。

```ts
if (keepsakes?.trim()) {
  lines.push('');
  lines.push(keepsakes.trim());
}
```

放在稳定段（`stableEnd` 之前），因为它一个月只变几次，不会破坏前缀缓存。

### 3.2 读取路径（关键：不能每轮查 D1）

`chat.ts` 每轮会拼提示词，直接 `SELECT` 会多一次 D1 往返（约 30–60 ms）。用 KV 缓存：

```ts
// KV key: keepsakes:block  （TTL 无需，随写入主动刷新）
async function loadKeepsakesBlock(env): Promise<string> {
  const cached = await env.KV.get('keepsakes:block');
  if (cached !== null) return cached;
  const block = renderKeepsakesBlock(await loadKeepsakes(env, 'approved'));
  await env.KV.put('keepsakes:block', block);
  return block;
}
```

任何一次写操作（新增 / 审核 / 取消置顶）后 `KV.put('keepsakes:block', 新块)`——写入频率一个月几次，代价可忽略。

## 4. 每日归档接入

`jobs.ts` 的 `runDailyArchive`，在 `distillDay` 成功之后、`mergeMemoryEntry` 之前插入：

```ts
try {
  const rules = await detectRuleKeepsakes(env, now.getTime());
  for (const k of rules) await insertKeepsake(env, k);
  const ai = await detectAiKeepsakes(env, target, conversation);
  for (const k of ai) await insertKeepsake(env, { ...k, source: 'ai', status: 'pending' });
  await refreshKeepsakesBlock(env);
} catch (e) {
  console.error('[daily] keepsake detect failed:', e);   // 绝不影响归档
}
```

注意 `conversation` 变量已经存在（就是喂给 `distillDay` 的那段），不要重复拼。

## 5. Admin 接口

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/admin/memory/keepsakes?status=pending` | 列表（含 pending） |
| POST | `/api/admin/memory/keepsakes` | 手动新增（`source=manual`，直接 approved） |
| POST | `/api/admin/memory/keepsakes/:id/status` | `{status:"approved"\|"rejected"}` |
| POST | `/api/admin/memory/keepsakes/:id/pin` | `{pinned:0\|1}` |

全部 `requireAuth`，和 `/api/admin/memory/events` 同一套写法。

## 6. 测试清单（12 条）

| # | 用例 | 期望 |
|---|---|---|
| 1 | `renderKeepsakesBlock([])` | 空串 |
| 2 | 只渲染 approved + pinned | pending/rejected 不出现 |
| 3 | 超过 30 条 | 保留最早的 30 条 |
| 4 | 日期按北京时间 | `2026-10-26` 不为 `2026-10-25` |
| 5 | AI 候选 JSON 缺字段 | 丢弃，不抛异常 |
| 6 | AI evidence 不是原话 | 丢弃 |
| 7 | title 31 字 | 截到 24 |
| 8 | 重复标题（大小写/标点不同） | 第二次 `duplicate` |
| 9 | 单日 3 条 AI 候选 | 只入册 2 条 |
| 10 | `detectAiKeepsakes` 抛错 | 归档继续，日志有记录 |
| 11 | 规则 `first_meet` 跑两次 | 只插一条 |
| 12 | 写入后 KV 块被刷新 | `keepsakes:block` 内容变了 |
| 13 | bitter 条目渲染 | 带「还气不气看你现在的情绪」，并出现「别主动翻旧账」提示 |
| 14 | bitter 超过 8 条 | 只渲染最早 8 条 |
| 15 | kind=first_fight 但 tone=warm | 强制改成 bitter |
| 16 | 同一天 2 条 bitter 候选 | 只入册 1 条 |

## 7. 验收（K-4，20 问）

| 问法示例 | 期望 |
|---|---|
| 「我们第一次说话是什么时候」 | 说出日期，不编内容 |
| 「你叫什么名字」 | 说出 memory.md 里的名字 |
| 「你名字怎么来的」 | 只有记录过才讲，否则说记不清 |
| 「我们第一次吵架是因为什么」 | 有记录则准确，无记录说记不清 |
| 「你答应过我什么」 | 只提记录里的约定 |
| 「我们吵过架吗」 | 有记录就承认，语气看当前情绪，**不主动扩大** |
| 「你还生气吗」 | 按 `grievance` 回答，不被铭记条目绑死 |

指标：命中 ≥ 90%、编造 0 条、注入 ≤ 2.5 KB、「第一次」类问题缓存命中率下降 ≤ 1 个百分点。

## 8. 回滚

| 情况 | 动作 |
|---|---|
| 注入后回复变差 | `KV.put('keepsakes:enabled', '0')` → `loadKeepsakesBlock` 返回空串 |
| 误记太多 | 全部 `status='pending'`，不注入 |
| 表要撤 | 表独立，不影响 memory.md 和 memory_chunks |

## 9. 施工顺序

| 步骤 | 内容 | 产出 |
|---|---|---|
| 1 | 迁移 + `keepsakes.ts` 骨架（建表/读取/渲染/插入） | 可单测 |
| 2 | `renderKeepsakesBlock` + 12 条测试里的 1–4、7–8 | 渲染稳定 |
| 3 | prompt.ts + chat.ts 接入（KV 缓存） | 手动插一条能在提示词里看到 |
| 4 | 规则识别 5 条 + 测试 11 | 首条消息/取名自动记 |
| 5 | Admin 4 个接口 | 能人工审核 |
| 6 | AI 候选 + 校验 + 测试 5、6、9、10 | 每日自动候选 |
| 7 | 20 问验收 | K-4 数据 |

前 5 步是 K-1 + K-2（约 2 天），第 6 步是 K-3（1 天），第 7 步 K-4（0.5 天）。