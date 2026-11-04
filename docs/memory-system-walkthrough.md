# 记忆系统实现说明（Memory System Walkthrough）

> 适用范围：`ds-memory` Worker（网页 / OpenAI 兼容端点 / 主动消息三条链路）。
> 定位：**实现级**说明——数据在哪、谁读写、按什么顺序、有哪些阈值、失败怎么降级、出问题怎么查。
> 概念与产品视角见 [README](../README.md#记忆系统)、[architecture.md](./architecture.md)；本文以代码为准，最后更新 2026-10-27。

---

## 0. 阅读指南

| 你想知道 | 看哪一节 |
|---|---|
| 记忆到底存在哪些地方 | [2. 存储布局](#2-存储布局) |
| 每轮聊天怎么把记忆拼进提示词 | [4. 读路径](#4-读路径每轮聊天的记忆装配) |
| 每天的提炼/归档做了什么 | [5. 写路径](#5-写路径每天-0400-的归档与提炼) |
| `memory.md` 的合并/去重/分层规则 | [6. memory.md 维护纯函数](#6-memorymd-维护纯函数) |
| 索引、结构化记忆、周月摘要怎么来的 | [7. 派生视图](#7-派生视图索引与结构化记忆) |
| 某个数字（16KB/6 条/2400B…）在哪定义 | [8. 参数总表](#8-参数总表) |
| 线上表现不对，先查什么 | [10. 排障手册](#10-排障手册) |
| 哪些注释/文档已经过期 | [11. 已知不一致](#11-已知不一致与待办) |

**三条贯穿全系统的设计原则：**

1. **本体不可丢**：`memory.md`、`memory/archive.md`、`chat_logs/` 是本体；索引、facts/chunks、周月摘要、KV 缓存全是**可重建的派生视图**。
2. **读便宜、写沉重**：读路径只做“取缓存 + 打分/召回 + 拼 prompt”，所有贵操作（LLM 提炼、embedding、大批量重写）都放在 04:00 归档或 `waitUntil` 异步任务里。
3. **降级不阻断**：任何记忆读写失败都退化为“这一轮少带点记忆”，聊天主流程永远继续（对应函数里几乎都 `try/catch → 返回空`）。

---

## 1. 术语表

| 术语 | 含义 |
|---|---|
| 长期记忆 / 本体 | R2 `memory.md`，8 个固定分区的 markdown |
| 档案层 | R2 `memory/archive.md`，append-only 的旧条目，按需召回 |
| 中期记忆 | `runtime_state` 的 `memo:24h`，最近 24 小时的滚动纪要 |
| 短期记忆 | D1 `messages` 最近 N 轮原文（不足时从 R2 归档补） |
| legacy 引擎 | 基于 D1 `memory_entries` 的召回路径（默认线上） |
| next 引擎 | 基于 `memory_facts/events/chunks` 的 Memory Context 召回路径 |
| 分层（demote） | 本体超过 24KB 时，把最旧条目从 `memory.md` 搬进 `archive.md`（只搬不删） |
| 派生视图 | 可由本体重建的数据：`memory_entries`、`memory_chunks`、`memory_rollups`、KV 缓存 |
| provenance | 事实的来源消息 id（`source_message_ids`） |
| origin | 数据的来源标记：`memory / conversation / archive / rollup / correction / legacy` |

---

## 2. 存储布局

### 2.1 一张表看全

| 层 | 载体 | 键 / 表 | 生命周期 | 谁写 | 谁读 |
|---|---|---|---|---|---|
| 长期本体 | R2 | `memory.md` | 永久（不自动删） | 每日归档 / 手动纠正 | 每轮聊天 |
| 长期档案 | R2 | `memory/archive.md` | 永久（append-only） | 归档（过期近期动态、分层） | 召回 |
| 本体备份 | R2 | `memory/backup/*.md`、`memory/backups/*.md` | 手动 | 投影 / 重新提炼前 | 排障 |
| 日归档 | R2 | `chat_logs/YYYY-MM-DD.log`（内容是 JSON） | 月度合并后删 | 每日归档 | 短期回补、提炼输入 |
| 月归档 | R2 | `chat_logs/YYYY-MM.json` | 保留 | 月度合并 | 短期回补、D1 清理判定 |
| 当日上下文 | R2 | `context/YYYY-MM-DD.json` | 90 天 | 归档 / 8h 刷新 / 聊天记天气 | 聊天、归档 |
| 检索索引 | D1 | `memory_entries` | 可重建 | `reindexMemory` | legacy 召回 |
| 结构化事实 | D1 | `memory_facts` / `memory_events` / `memory_chunks` / `memory_summaries` | 可重建 | `replaceMemoryContext` 等 | next 召回、投影、后台任务 |
| 周月摘要 | D1 | `memory_rollups` | 可重建 | `generateRollup` | 召回补 2 条、同步成 summaries |
| 任务队列 | D1 | `memory_jobs` | 滚动 | 每日归档 enqueue | `runMemoryJobs` |
| 运行时状态 | D1 `runtime_state`（KV 兜底） | `memo:24h`、`summary:YYYY-MM-DD`、各类锁 | 按 TTL | 异步任务 | 每轮聊天 |
| 消息 | D1 | `messages` | 只保留今天+昨天，更早需已归档 | 每次聊天 | 短期记忆、归档、统计 |
| 缓存 | KV | `memory:cache`（24h）、`memory:index`（1h）、`relation:active_days`、`aversion:candidates` 等 | 按 TTL | 读路径回填 | 读路径 |

> Phase 1 之后，`memo/summary/emotion/profile/weather/cost/heartbeat` 等高频状态已从 KV 迁到 D1 `runtime_state`；KV 只留低频或大对象。迁移清单见 [current-state.md §7](./current-state.md)。

### 2.2 读写流向

```text
                    ┌──────────────────────────── 读（每轮聊天）────────────────────────────┐
                    │                                                                      │
  messages(D1) ──► 短期 N 轮原文        memory.md(R2) ──KV 24h──► 长期记忆视图(full/compact)
       │                                    │                              │
       └──► 归档回补(R2 chat_logs)          └──► memory_entries(D1) ──► legacy 召回 top-k ─┤
                                                                         │                   │
                    runtime_state(D1) ──► memo:24h / 今日摘要 ────────────┼──────────────────►│──► prompt ──► DeepSeek
                                                                         │                   │
                    memory_chunks(D1) ──► next 召回(RRF+MMR+装包) ───────┘                   │
                    memory_rollups(D1) ─► 周/月摘要补 2 条 ───────────────────────────────────┘
                    └──────────────────────────────────────────────────────────────────────┘

                    ┌──────────────────────────── 写（每天 04:00）────────────────────────────┐
  messages(D1) ──► 日归档 chat_logs/*.log(R2) ──► distillDay(LLM) ──► 条目
                                                                    │
                                                                    ▼
                                        mergeMemoryEntry（分区合并/同键覆盖/去重/关系值）
                                                                    │
                 ┌──────────────────────────────────────────────────┼───────────────────────┐
                 ▼                        ▼                         ▼                       ▼
        近期动态搬档案            已完成事项搬共同经历          雷区学习            保守去重 + >24KB 分层
                 └──────────────────────────────────────────────────┼───────────────────────┘
                                                                    ▼
                                                    putMemory(R2 + 刷 KV memory:cache)
                                                                    │
                 ┌──────────────────────────────┬───────────────────┼───────────────────┬──────────────┐
                 ▼                              ▼                   ▼                   ▼              ▼
        reindexMemory(memory_entries)   replaceMemoryContext   周/月摘要           memory_jobs      D1 清理
                                        (facts/events/chunks)  (rollups)          (5 类任务)      (只删已归档)
```

---

## 3. 数据结构

### 3.1 `memory.md` 格式

8 个固定分区，顺序由 `SECTION_ORDER` 决定（[memory-maintenance.ts](../src/memory-maintenance.ts#L120-L129)）：

| # | 分区 | 角色 | 保护级别 |
|---|---|---|---|
| 1 | `## 人物底色` | 固定人设 | **不可变**：提炼时忽略、压缩时取出放回、裁剪时跳过 |
| 2 | `## 称呼与关系` | 称呼/暗号 + 6 行关系值 | **受保护**：不自动删、不自动合并 |
| 3 | `## 关于他` | 长期身份事实 | 受配额（2000B）/同键覆盖 |
| 4 | `## 他的偏好` | 喜好、作息、沟通方式 | 受配额（1800B）/同键覆盖 |
| 5 | `## 进行中的事` | 项目/待办，带 `[进行中]/[搁置]/[已完成]` | 走分层，不做合并 |
| 6 | `## 共同经历` | 一起做过的事、梗、约定 | 走分层，不做合并 |
| 7 | `## 他的雷区` | 忌讳话题 | **受保护**：永不自动删 |
| 8 | `## 近期动态` | 最近几天，7 天过期 | 走分层 + 按天归档 |

条目行格式：

```markdown
- [YY-MM-DD] 电报体内容            ← 新写入（省字节）
- [YYYY-MM-DD] 内容                ← 兼容旧数据，解析时统一成 4 位年
- [YY-MM-DD] 键=值                 ← 「关于他/他的偏好」里的稳定事实，同键原地覆盖
- [YYYY-MM-DD] 好感度：523 / 1000  ← 关系值行，不参与条目合并/索引
```

其他约定：

- 文件头 `# 长期记忆` + `>` 引用说明行；`<!-- 注释 -->` 保留给人看，注入前会被剥掉。
- 关系值共 6 行：好感度 / 亲密度 / 心情值 / 信任 / 尊重 / 心动（0–1000）。
- 条目日期前缀是**唯一的排序/过期依据**，所以新增条目必须带日期（缺日期时由 `mergeMemoryEntry` 用归档目标日补齐）。

### 3.2 D1 表

完整 DDL 见 [schema.sql](../schema.sql) 与 [migrations/004-memory-context.sql](../migrations/004-memory-context.sql)、[005-memory-jobs.sql](../migrations/005-memory-jobs.sql)。

| 表 | 关键字段 | 说明 |
|---|---|---|
| `memory_entries` | `id, section, content, date, importance, tags, keywords, vec, source, dup_of` | legacy 索引视图；`source` = memory/archive；`dup_of` = 语义去重指针 |
| `memory_facts` | `id, section, content, subject/predicate/object, valid_from/valid_to, confidence, source_message_ids, tags, content_hash, origin` | 结构化事实，带有效期与 provenance |
| `memory_events` | `id, section, date_key, summary, participants, emotions, source_message_ids, origin` | 事件类记忆 |
| `memory_chunks` | `id, source, source_id, section, content, date, keywords, tags, importance, vec, content_hash, origin` | 召回单元（fact/event/summary 统一成 chunk） |
| `memory_summaries` | `id, level, period, content, source_ids, origin` | 周/月摘要的结构化形态 |
| `memory_rollups` | `id='week:YYYY-MM-DD' / 'month:YYYY-MM'`, `content, entry_count, source_hash` | 摘要本体（先有 rollup，再同步成 summary + chunk） |
| `memory_jobs` | `id, type, target, status, attempts, error` | 可重试任务：`rebuild_context / sync_summaries / sync_archive / embed_chunks / backfill_provenance / extract_conversation` |
| `messages` | `id, role, content, turn_id, turn_type, reply_to_id, channel, date_key, created_ms` | 短期记忆来源 |
| `cron_runs` | `(job_type, target) UNIQUE`, `status, detail, run_at` | 归档/合并的幂等与补跑依据 |
| `runtime_state` | `key, value, updated_at, expires_at` | memo/summary/锁/心跳等 |

> ⚠️ 升级到 Phase 2 检索前，必须先执行 `migrations/002-memory-index-dup-of.sql`（补 `memory_entries.dup_of`），否则 `reindexMemory` 写不进去。`src/schema.test.ts` 有对应断言。

---

## 4. 读路径：每轮聊天的记忆装配

### 4.1 时序（`chat.ts` 网页链路）

`streamChat`（[chat.ts](../src/chat.ts#L49)）在落库用户消息**之前**取历史，避免本轮消息出现在历史里：

```text
1. 并行读取：getMemory / getOrCreateDayContext / fetchWeather / loadRecentRounds
             / getRecentMemo / getTodaySummary / loadPersonaState
2. promptMemory = extractPromptMemory(memory)         → full 或 compact
3. recentMemo = formatRecentMemoBlock(memo)           → 有 memo 就不注入今日摘要
4. recallMemoryForChat(当前消息 + 最近 3 条用户历史, focus=最近 8 条)
5. [可选] shadow/next 引擎再跑一遍 Memory Context 召回
6. recalled = stripDuplicateRecall(recalled, 历史 + memo + 长期记忆)
7. processEmotionTurn（情绪/关系，不属于记忆本体但会影响状态卡）
8. insertUserMessage → buildSystemPrompt → streamDeepSeek
9. 流结束 onFinish：落 assistant 消息 + 计费
```

`openai.ts`（AstrBot）与 `webproactive.ts`（主动消息）结构相同，只是历史/historyNote 的来源与 `skipRecording` 规则不同（[openai.ts#L399-L560](../src/openai.ts#L399-L560)、[webproactive.ts#L170-L310](../src/webproactive.ts#L170-L310)）。

### 4.2 长期记忆：加载与注入模式

```ts
// memory.ts
getMemory: KV memory:cache(24h) → miss 时读 R2 memory.md 并回写 KV → 失败返回 ''
putMemory: 先 delete KV → 写 R2 → 再写 KV（先删保证不会读到旧值）
```

`extractPromptMemory`（[memory-index.ts#L115-L121](../src/memory-index.ts#L115-L121)）：

| 条件 | mode | 注入内容 |
|---|---|---|
| `byteLength(memory) ≤ 16KB` | `full` | 整份 `memory.md` |
| 更大 | `compact` | `STABLE_SECTIONS` = 人物底色 + 称呼与关系 + 他的雷区 + 关于他 + 他的偏好 |

`prompt.ts` 还会再过一层 `compactMemoryForPrompt(memory, 24576)`（[memory-maintenance.ts#L48-L64](../src/memory-maintenance.ts#L48-L64)）：剥注释/引用行/空行；仍超 24KB 时依次牺牲 `共同经历 → 近期动态 → 进行中的事` 的最旧条目，最后才按日期裁；**只改本次注入视图，不动 R2 文件**。

> compact 模式下 prompt 会额外提示：“其余记忆按本轮话题检索，可能不完整；没检索到就说记不清，不要编。”

### 4.3 legacy 召回：`recallMemoryForChat`

入口 [memory-index.ts#L713-L879](../src/memory-index.ts#L713-L879)。完整流水线：

```text
① loadRows：三级缓存取全量索引行
      isolate 内存(5min) → KV memory:index(1h) → D1(memory_entries) 回源并回写 KV
② 过滤：去掉 dup_of 非空的行；full 模式下只保留 source='archive'
③ 关键词打分 scoreRow（见下表）
④ 候选池：score>0 排序后取前 CANDIDATE_TOP_K = 20
⑤ 按需查询向量：候选 < k / top 分 < 6 / 查询含指代词 → bge-m3 生成 query 向量，重算分数
⑥ MMR 去冗余：Jaccard 相似度惩罚，选 top-k = 6
⑦ 条件 LLM 重排：候选多/查询长/有指代/分差小 → 让模型只输出序号数组；1.2s 超时回退
⑧ 强保「进行中的事」：没选中就替换掉分数最低的一条
⑨ 无命中直接返回空（不再用 rows.slice(0,k) 兜底）
⑩ 格式化：stripTags → clipMatchedClauses → abbreviateKeys，带 [date]
⑪ 追加命中的周/月摘要，最多 2 条
```

`scoreRow` 的权重：

| 信号 | 加分 | 备注 |
|---|---|---|
| 查询 bigram 命中条目 `keywords` | +1 / 个 | `keywords` 是 top24 bigram |
| 命中行内标签 `#作息`/`#技术`… | +3 | 标签由规则表生成 |
| 英文/数字强词（项目名、命令、缩写） | +2 | `strongWords` 且长度 ≥3 |
| 同义词扩展词（熬夜↔通宵、部署↔上线…） | +2 | `QUERY_ALIASES` |
| `focus`（最近 8 条历史）里的强词 | +2 | 让“接着聊下去”优先 |
| 向量余弦 | `cos × 3` | 仅在算过 query 向量时 |
| 分区重要度 | `importance` | **只在 score > 0 时加**，防止无关条目靠重要度混进候选 |
| 时间衰减 | ×0.5 / ×0.25 | >60 天 / >90 天（北京时间基准） |

格式化时：

- `clipMatchedClauses`：≤70 字原样返回；更长则按标点切句，只拼**命中的子句**，上限约 90~130 字；没命中任何子句就截前 90 字 + `…`。
- `abbreviateKeys`：`城市→城、职业→职、喜好→喜、颜色→色、居住→住`，只在注入视图生效（prompt 里有对应说明）。
- 空壳保护：`picked.length === 0` 直接返回 `''`。

### 4.4 next 召回：Memory Context

三条链路同构（[chat.ts#L108-L169](../src/chat.ts#L108-L169)、[openai.ts#L561-L621](../src/openai.ts#L561-L621)、[webproactive.ts#L248-L295](../src/webproactive.ts#L248-L295)）：

```text
shouldRecallMemory(query)  ← 查询规划：寒暄/纯技术不检索；「上次/之前/记得/我说过」必检索
loadMemoryChunks()         ← D1 memory_chunks（全量，当前规模小）
rankMemoryChunks()         ← 关键词分 + 可选向量分 → RRF(K=60) 融合 → MMR(lambda 0.75)
packMemoryChunks()         ← 2400 字节预算，contentHash 去重，超预算整条丢弃
formatMemoryChunks()       ← '## 相关记忆（Memory Context）'
```

- **RRF**：关键词 top30 与向量 top30 各按名次累加 `1/(60+rank+1)`，不用绝对分数融合。
- **MMR**：有向量用余弦，无向量退化为内容 bigram 的 Jaccard；`lambda=0.9`（纯关键词）/`0.75`（融合后）。
- **查询规划**：`GREETING_RE`（在吗/早安/哈哈…）、`TECH_RE`（帮我写/解释/翻译…）不触发；`MEMORY_MARK_RE` 强制触发；其余长度 ≥3 触发。
- **引擎开关**：`shadow` 只把条数/字节/耗时写 trace 和 `engine_metrics`，**不改变回复**；`next` 才用 `nextRaw` 替换 `recalledRaw`；任何异常吞掉并回退 legacy。
- 按渠道解析：`MEMORY_ENGINE_QQ/MOBILE/WEB` → 全局 `MEMORY_ENGINE` → `legacy`（[engine-flags.ts](../src/engine-flags.ts)）。

### 4.5 跨层去重：`stripDuplicateRecall`

[memory-index.ts#L592-L610](../src/memory-index.ts#L592-L610)。把“历史原文 + memo + 长期记忆视图”切成子句，做归一化指纹（去标点、去 `[日期]`、小写、长度 ≥6），再从召回块里剔除相同子句；整行都重复就整行删。

目的：同一事实不要在 prompt 里出现三遍（长期 + 中期 + 召回），既省 token 也避免模型“复读”。

### 4.6 中期与短期

**中期（memo:24h）**——[recent-memory.ts](../src/recent-memory.ts)

| 项 | 值 |
|---|---|
| 窗口 | 最近 24h（`created_ms ≥ now-24h`） |
| 刷新触发 | 新增 ≥15 条 **或** 距上次 ≥3h |
| 最小增量 | ≥4 条新消息（表重置时强制） |
| 并发保护 | `runtime_state` 原子 UPSERT 锁，TTL 120s |
| 输入 | 旧纪要 + 新增对话（最多 300 条 / 12000 字，保留最新） |
| 输出 | 5~8 条、每条 ≤24 字、最多保留 8 条 |
| 存储 | `runtime_state` `memo:24h`，TTL 48h，含 `up_to_id / updated_at` |
| 费用 | `addLlmCost` 计入当天 |

刷新由 `/api/chat`、`/v1/chat/completions` 在响应前用 `waitUntil` 异步触发，失败只打日志。

**今日摘要（兜底）**——[summary.ts](../src/summary.ts)

首次 ≥20 条消息触发；之后新增 ≥10 条或距上次 ≥1h 再生成；约 100 字（代码截 180）；TTL 36h；**memo 存在时不注入**；归档后删除。

**短期（最近 N 轮）**——[recent-context.ts](../src/recent-context.ts)、[db.ts](../src/db.ts#L194-L227)

| 项 | 值 |
|---|---|
| 默认轮数 | 15 |
| 技术/项目类 | 30（长度 >80 或含“代码/报错/部署/记忆…”） |
| 明确指代前文 | 50（“接着刚才/继续前面/前面那个…”） |
| 硬上限 | 60 |
| 取法 | 按 `turn_id` 分组取最近 N 轮 → 不足时从 R2 日归档（月归档）向前补最多 3 天 |
| 注入 | 时间升序，每条 `[MM-DD HH:mm]` 前缀；单条 2400 字（带文件 4200 字）压缩为“前 70% + 后 30%” |

`openai.ts` 还会按轮数再加**字符预算**：50 轮 14000 字 / 30 轮 10000 / 默认 7000，超了从最旧消息开始丢。

> 注意：`chat.ts`（网页）走的是 `resolveRecentRounds` 默认值，不额外做字符预算；只有 `/v1/chat/completions` 在 `inject_history=true` 时才应用上面的字符预算。

### 4.7 prompt 中的记忆位置

`buildBaseSystemPrompt`（[prompt.ts#L80-L255](../src/prompt.ts#L80-L255)）按“稳定 → 易变”排序，让 DeepSeek 前缀缓存命中（输入价 0.04 vs 2.0 元/M）：

| 顺序 | 段落 | 稳定性 |
|---|---|---|
| ① | 人设 + 称呼 | 几乎不变 |
| ② | `## 长期记忆`（full）或 `## 核心记忆`（compact） | 每天 04:00 才变 |
| ③ | `## 记忆使用规则` | 固定 |
| ④ | `## 对用户的态度` + 口语化指令 | 缓慢变化 |
| ⑤ | `## 当前时间与环境` | 每轮变（所以放后面） |
| ⑥ | 角色状态卡 / 最近文件 / **中期记忆** | 易变 |
| ⑥.5 | **相关往事 / 相关记忆（召回）** | 每轮变 |
| ⑦ | 今日摘要 | 易变 |
| ⑧ | `## 实时事实（最高优先级）` | 固定在最后，离用户消息最近 |

`## 记忆使用规则` 明确给了模型权重与冲突处理：

- 长期记忆 50%（稳定身份/偏好/关系/雷区）；
- 中期记忆 20%（最近 24 小时，用来衔接跨天）；
- 短期记忆 30%（当前原文，最新说法优先）；
- 冲突：稳定看长期、最近看中期、具体说法看短期；三种都只是背景。

---

## 5. 写路径：每天 04:00 的归档与提炼

### 5.1 触发

```text
cron "0 20 * * *"（UTC）= 北京 04:00
  → runDailyArchive(env, now)
      ├─ 容量检查 / 反馈回填 / 队列清理 / R2 context 清理
      ├─ 补跑：failed 日期 + 卡死 running + D1 有消息但 R2 无归档（≤7 天）
      ├─ archiveOneDay(前一天)
      ├─ maybeReviewPersonaDrift（≥7 天/15 条消息才结算）
      └─ cleanupOldMessages（只保留今天+昨天，且必须已归档+提炼成功）
  → 每月 1 日：等 runDailyArchive 完成后 runMonthlyMerge
```

### 5.2 `archiveOneDay` 步骤

[jobs.ts#L146-L594](../src/jobs.ts#L146-L594)，严格顺序：

| # | 步骤 | 失败时的行为 |
|---|---|---|
| 1 | `claimJob`：`cron_runs` 唯一约束占位；当天跑过的 `done` 视为临时归档允许次日重跑；`running` >2h 允许接管 | 幂等跳过 |
| 2 | 取当天消息；D1 已清理则从 R2 日/月归档恢复；最后一条是 user 时补上跨天 AI 回复 | 继续 |
| 3 | 取当日 context + 天气快照 | 用实时天气兜底 |
| 4 | 写 `chat_logs/日期.log`（JSON：context + messages） | 抛错 → 任务 failed |
| 5 | 回读归档文件当作提炼输入（`memory:false` 时到此返回） | 回退内存里的 rows |
| 6 | `distillDay`：memory.md 全文 + 当天对话（≤60000 字）→ 条目 | 记 `distill_error`，任务标 failed，次日补跑 |
| 7 | `mergeMemoryEntry` 合并进 memory.md；同时收集关系驱动统计 | 不影响归档 |
| 8 | 情绪天级结算：Workers AI 复核 ≤8 条歧义消息 → 8 维向量 → 5 轴取整 → 心情投影 | 打日志继续 |
| 9 | 近期动态 7 天过期：**先搬档案并回读验证**，确认后才从本体删 | 验证失败保留本体 |
| 10 | `[已完成]` 超 3 天 → 搬到共同经历 | 打日志继续 |
| 11 | 雷区学习（反感信号累计 → 提升进雷区） | 打日志继续 |
| 12 | 长期不联系的关系衰减（只降亲密度） | 打日志继续 |
| 13 | 保守去重 `compactMemoryEntries` | 打日志继续 |
| 14 | >24KB 无损分层到 archive.md（每区至少留 4 条，写后验证） | 验证失败中止该区 |
| 15 | `putMemory`（R2 + 强制刷 KV） | 抛错 → failed |
| 16 | `reindexMemory` 重建 memory_entries | 记录，可手动补 |
| 17 | `replaceMemoryContext(origin='memory')` 重建 facts/events/chunks | 记录，可手动补 |
| 18 | `maybeGenerateRollups`（周一/1 号） | 记录 |
| 19 | enqueue 5 个任务并立即 `runMemoryJobs(limit=5)` | 失败时回退直接调用 |
| 20 | 删当天滚动摘要、写关系快照进 context、`addLlmCost`、`finishJob` | — |

关键点：

- **提炼失败 ≠ 归档完成**：`finishJob` 只在没有 `distillError` 时写 `done`；否则写 `failed`，次日补跑。`cleanupOldMessages` 也因此绝不删“提炼失败”日期的 D1 消息。
- **写后验证**：搬档案（步骤 9/14）都要求“回读档案确认存在”才允许从本体删除，避免“搬丢了”。
- **幂等**：`cron_runs(job_type,target)` 唯一；白天临时归档次日重跑由 `isProvisionalArchiveRun` 判定。

### 5.3 提炼 prompt 的约束

`DAY_DISTILL_SYSTEM`（[distill.ts#L16-L54](../src/distill.ts#L16-L54)）要点：

- 分区职责明确（称呼/关于他/偏好/进行中/共同经历/雷区/近期动态）；
- **密度优先**：电报体、去主语助词、`；` 分句、`/` 并列、单条 ≤50 字、半角标点；
- 稳定事实写 `键=值`（同键会被原地覆盖）；
- 只写“不写进去就会聊错”的东西；不编造、不推测；
- 每条 `- [YY-MM-DD] 内容`；没有内容的分区省略；**不输出人物底色**；
- 只允许输出 **心情值**；**禁止输出好感度/亲密度**（由代码按互动量/质量结算）；
- 视角：关于他/偏好/进行中保持第三人称；共同经历/近期动态可以有第一人称感受。

模型分工：每日提炼 `DISTILL_DEEPSEEK_MODEL`（默认 `deepseek-v4-pro`，质量优先），滚动摘要/重排/周月摘要用 `SUMMARY_DEEPSEEK_MODEL`（默认 `deepseek-flash`，成本优先）；失败统一回退 Workers AI（免费，费用记 0）。

### 5.4 月度合并

`mergeMonth`（[jobs.ts#L771-L850](../src/jobs.ts#L771-L850)）：

1. 先补缺失日期归档；
2. 仍缺天 → **拒绝合并**（宁可失败也不静默丢一天）；
3. 合并单日 `.log`，按消息 id 去重排序，做“合计条数 == 去重后条数”完整性校验；
4. 写月文件 + 回读校验；
5. 校验通过才删单日文件；
6. D1 只删“已成功合并且早于 3 个月”的月份。

---

## 6. `memory.md` 维护纯函数

全部在 [memory-maintenance.ts](../src/memory-maintenance.ts)，均为纯函数、可单测（`memory-maintenance.test.ts`）。

### 6.1 合并：`mergeMemoryEntry`

| 规则 | 实现 |
|---|---|
| 分区匹配 | 按 `## 标题` 找同名分区，没有就追加新分区 |
| 人物底色 | 直接忽略提炼输出里的同名分区（不可变） |
| 缺日期 | 用 `fallbackDate`（归档目标日）补 `[YY-MM-DD]` |
| 同键覆盖 | 只在「关于他/他的偏好」：`键=值` 同键**原地替换**，不叠加 |
| 归一化去重 | 忽略标点/空白/引号差异后相同则跳过 |
| 关系值行 | `好感度/亲密度/心情值/信任/尊重/心动` 不走普通条目，由 `applyRelationUpdates` 单独处理 |
| 无变化 | 返回原字符串（调用方据此判断 `distilled`） |

### 6.2 分区预算：`enforceSectionBudgets`

| 分区 | 预算（字节） |
|---|---:|
| 人物底色 | 2000 |
| 称呼与关系 | 800 |
| 关于他 | 2000 |
| 他的偏好 | 1800 |
| 进行中的事 | 1500 |
| 共同经历 | 1800 |
| 他的雷区 | 1200 |
| 近期动态 | 800 |

超预算时把该区**最旧两条合并成一条**（日期取较早者、用 `；` 连接），只合并不删除；受保护分区与 `DEMOTE_HEADERS`（共同经历/进行中的事/近期动态）跳过——后者走分层以保持检索精度。

> 说明：该函数当前不在每日归档主流程里调用（归档走的是去重 + 分层）；保留给手动/测试与后续使用。

### 6.3 去重、过期、分层、裁剪

| 函数 | 作用 | 保护 |
|---|---|---|
| `compactMemoryEntries` | profile 区：同键取新值、包含关系取信息更全；其它区：只合并“同一天同内容”；日期取更早 | 受保护分区整块跳过 |
| `pruneTransientSections` | `## 近期动态` 超过 7 天删除（调用方先搬档案并验证） | 只动该分区 |
| `demoteSectionEntries` | 全文超 24KB 时把某区最旧条目搬出（每区至少留 4 条） | 受保护分区不允许 |
| `trimOldestEntries` | 按日期整组删最旧直到 ≤ 预算（用于提示词视图兜底） | 受保护分区一行不删 |
| `archiveCompletedItems` | `[已完成]` 且超 3 天宽限 → 搬到共同经历并去掉标记 | — |
| `extractImmutableSection` / `injectImmutableSection` | 压缩时先取出人物底色、压缩后原样放回 | — |
| `memoryDensity` | 条目数/字节数/平均字节，写进归档日志与 `/api/admin/stats` | — |
| `reportSectionBudgets` | 分区占用诊断 | — |

### 6.4 关系值（与记忆同文件，但不是“记忆内容”）

| 轴 | 默认 | 单日上限 | 驱动 |
|---|---:|---:|---|
| 好感度 affection | 500 | ±5 | 互动质量（温暖/感谢/冒犯/冲突） |
| 亲密度 intimacy | 300 | ±5（受 `300 + 2×有效天数` 上限） | 互动量（轮次/连续天数/新增记忆） |
| 心情值 mood | 500 | ±80 | **情绪向量的投影**，不再是独立变量 |
| 信任 trust | 600 | ±4 | 情感事件 |
| 尊重 respect | 650 | ±4 | 情感事件 |
| 心动 attraction | 300 | ±4 | 情感事件 |

写入方式是 `setRelationValues`：**替换该行**而不是追加；`applyRelationDecay` 在 >7 天没联系时只降亲密度，好感不降。

---

## 7. 派生视图：索引与结构化记忆

### 7.1 legacy 索引：`memory_entries`

`reindexMemory`（[memory-index.ts#L189-L355](../src/memory-index.ts#L189-L355)）：

```text
getMemory + getArchiveLines
  → parseMemoryEntries（跳过核心区、关系值行；archive 默认 section='档案'）
  → 按 section|content 去重（memory 优先于 archive）
  → 稳定 id = me_<fnv1a36>_<len>
  → 保留已有向量；旧 float 数组就地转 int8；缺向量才重新 embed（每批 20 条）
  → 语义去重（仅索引视图）：同分区内按内容长度降序，余弦 ≥0.95 且长度比 ≥0.5 且标签有交集 → dupOf=主条目
     超过 3000 条则跳过 O(n²)
  → INSERT OR REPLACE 分批写（每批 100）
  → 删除本体里已不存在的幽灵行
  → 预热 isolate 缓存 + 写 KV memory:index
```

向量存储：`quantizeVec` 把 1024 维 float 压成 int8（`{min,max,b:base64}`），约 1.4KB；`decodeVec` 兼容旧 float 数组。KV 载荷超过 20MB 时**丢向量保关键词**。

### 7.2 结构化 Memory Context：facts / events / chunks

领域模型 [memory-domain.ts](../src/memory-domain.ts)：

| 函数 | 作用 |
|---|---|
| `parseMemoryContext` | 核心三区不解析；共同经历/近期动态 → events；其余 → facts；键值行解析成 subject/predicate/object |
| `canonicalizeFacts` | 按 `validFrom/validTo` 过滤过期 → 同槽位（section+subject+predicate）保留较新、合并 `sourceMessageIds` |
| `buildMemoryChunks` | facts/events → chunk（keywords=bigram top24、tags、importance） |
| `projectMemoryContext` | chunks/facts → markdown（核心区保留 pinned 原文） |
| `rankMemoryChunks` / `mmrSelectChunks` / `formatMemoryChunks` | 召回与渲染 |

持久化 [memory-context-store.ts](../src/memory-context-store.ts)：

| 函数 | 说明 |
|---|---|
| `replaceMemoryContext(text, origin)` | 解析 → 规范化 → 建 chunk → 保留已有 provenance → 先 upsert 再删同 origin 旧行（中途失败旧数据仍在） |
| `upsertConversationFacts` | 对话抽取的 facts（origin=conversation），同 id 合并来源 id |
| `syncArchiveContext` | archive.md 最近 500 行 → events/chunks（origin=archive） |
| `syncRollupSummaries` | rollups → summaries + chunks；`source_hash` 与当前条目指纹不一致时本轮不注入 |
| `embedMemoryChunks` | 给 `vec IS NULL` 的 chunk 补 bge-m3（默认 64、上限 200） |
| `backfillMemoryProvenance` | 用事实片段在 messages 里 `instr` 近似回溯来源 id（最多 5 条/事实） |

### 7.3 周/月摘要（时间金字塔）

`memory-rollups.ts`：

- 周期：周（周一为起点）、月；
- 输入：该周期内 `memory_entries` 的条目（可带“现有摘要”，增量式），超长保留最新 12000 字；
- 输出：≤300 字电报体，代码截 600；
- 幂等：`id = week:YYYY-MM-DD / month:YYYY-MM`，`source_hash` 记录来源指纹；
- 触发：周一滚上周、每月 1 日滚上月；归档时自动跑，`/api/admin/memory/rollup` 可手动；
- 作用：平时不常驻；召回命中关键词时最多补 2 条，让老记忆用更少字被想起。

### 7.4 显式纠正

`applyMemoryCorrection`（[memory-correction.ts](../src/memory-correction.ts)）：

- 入口：App `/更正 职业=嵌入式开发`、`/api/app/location` 写位置；
- 带键纠正 → 正则替换同键旧行；
- 无法识别键 → 写入 `## 他的更正（最高优先级）`；
- 写后链路：`putMemory` → `replaceMemoryContext(origin='correction')` → `reindexMemory` → 删除并重算当前周/月 rollup → 补 embed；
- 内容上限 500 字。

### 7.5 显式事实抽取

`extractFactsFromMessages`（[memory-extract.ts](../src/memory-extract.ts)）只认显式自述（我住在X/我叫X/我的猫叫X/我喜欢X/我讨厌X/我在做X/我用的是X），`confidence=0.6`，带来源消息 id；由 `extract_conversation` 任务扫描最近 3 天用户消息（≤300 条）。

### 7.6 投影（默认不自动执行）

`memory-projection.ts`：`build → validate → 备份 → 写回`。校验项：非空、≤16KB、以 `# 长期记忆` 开头、核心区标题未丢。触发接口需要 `confirm: true`。用于 Phase 5 切“以 facts 为真相”前的演练。

### 7.7 雷区主动学习

`aversion.ts`：

1. `scanAversions` 扫描当天用户消息的“不想聊这个/换个话题/别提了/烦死了/有阴影…”；
2. 话题取上一条用户消息里最长的实词片段聚簇；
3. 候选池存 KV `aversion:candidates`（TTL 30 天，最多 50 条）；
4. 同话题 ≥2 次或强信号（score ≥3）一次 → 提升，写入「他的雷区」。

### 7.8 档案层

`memory-archive.ts`：

- 写入 `appendArchiveLines`：从 R2 读全文（不走缓存）→ 自动打标签 → 归一化去重 → 写回；读失败直接返回 0，**绝不用新条目覆盖旧档案**；
- 读取 `getArchiveLines`：isolate 缓存 5 分钟，**不做截断**（历史 bug：缓存全量、R2 命中却 `slice(-2000)`，导致每次追加把 2000 行前历史永久丢掉）；
- 检索 `pickRelevant`：bigram 按文档频次加权（区分度高 2 分/普通 1 分）+ 标签 +3 + 强词 +2 + 同义词 +2（只对不常见词），低于 2 分视为噪声，同分新的优先；
- 生产聊天现在主要走 D1 索引，`recallForQuery` 保留给单测/兼容。

---

## 8. 参数总表

| 参数 | 值 | 位置 |
|---|---:|---|
| 长期记忆全量注入阈值 | 16 KB | `MEMORY_INLINE_MAX_BYTES` |
| 提示词内 memory 硬上限 | 24576 B | `MEMORY_PROMPT_MAX_BYTES` |
| 分层目标（本体） | 24000 B | `CORE_TARGET_BYTES` |
| 分层每区最少保留 | 4 条 | `demoteSectionEntries(keepAtLeast=4)` |
| 档案过期保留 | 近期动态 7 天 | `TRANSIENT_KEEP_DAYS` |
| 已完成事项宽限期 | 3 天 | `PENDING_ARCHIVE_GRACE_DAYS` |
| legacy 召回 top-k | 6 | `RECALL_TOP_K` |
| legacy 候选池 | 20 | `CANDIDATE_TOP_K` |
| legacy MMR 惩罚 | 6 | `MMR_PENALTY` |
| 语义去重余弦阈值 | 0.95 | `SEMANTIC_DUP_COSINE` |
| 语义去重条目上限 | 3000 | `MAX_SEMANTIC_DEDUP_ENTRIES` |
| 触发 query embedding 的分数 | 6 | `VECTOR_TRIGGER_SCORE` |
| LLM 重排超时 | 1200 ms | `RERANK_TIMEOUT_MS` |
| next 召回字节预算 | 2400 B | `RECALL_BUDGET_BYTES` |
| 档案召回条数 / 最低分 | 4 / 2 | `RECALL_LIMIT` / `RECALL_MIN_SCORE` |
| 中期窗口 / 条数 / 时长触发 | 24h / 15 条 / 3h | `MEMO_*` |
| 中期最小增量 / 最多条数 | 4 条 / 8 条 | `MEMO_MIN_NEW_MESSAGES` / `MEMO_MAX_ITEMS` |
| 中期 TTL | 48h | `MEMO_TTL_SECONDS` |
| 中期输入上限 | 300 条 / 12000 字 | `MEMO_MAX_SOURCE_MESSAGES` / `MEMO_INPUT_MAX_CHARS` |
| 今日摘要首次触发 | 20 条 | `SUMMARY_TRIGGER_COUNT` |
| 今日摘要后续触发 | +10 条 或 1h | `SUMMARY_TRIGGER_DELTA` / `INTERVAL_MS` |
| 今日摘要 TTL | 36h | `SUMMARY_KV_TTL_SECONDS` |
| 短期默认轮数 / 上限 | 15 / 60 | `RECENT_ROUNDS` / `MAX_RECENT_ROUNDS` |
| 短期单条字符 | 2400 / 带文件 4200 | `HISTORY_MESSAGE_MAX_CHARS` / `HISTORY_FILE_MAX_CHARS` |
| 摘要模型上限 | 512 tokens | `generateRollup` |
| 提炼输入上限 | 60000 字 | `distillDay` |
| KV 索引 TTL / isolate 缓存 | 1h / 5min | `INDEX_KV_TTL_SECONDS` / `MEM_CACHE_TTL_MS` |
| KV 索引丢弃向量的载荷阈值 | 20 MB | `KV_INDEX_MAX_BYTES` |
| query 向量 / 解码向量缓存上限 | 200 / 5000 | `qvecMem` / `decodedVecCache` |
| 情绪 AI 复核单日上限 | 8 次 | `reviewDayEvents` |
| embedding 批大小 | 20（重建）/ 64（补 chunk，上限 200） | `reindexMemory` / `embedMemoryChunks` |
| 归档补跑上限 | 7 天 | `CATCHUP_LIMIT` |
| 卡死 running 接管阈值 | 2h | `STALE_RUNNING_MS` |
| D1 消息保留 | 今天 + 昨天 | `cleanupOldMessages` |
| 月合并后 D1 清理 | 早于 3 个月 | `mergeMonth` |

---

## 9. 缓存、预算与降级

### 9.1 缓存层次

| 缓存 | 位置 | TTL | 失效方式 |
|---|---|---|---|
| `memory:cache` | KV | 24h | `putMemory` 先 delete 再写 |
| `memory:index` | KV | 1h | `reindexMemory` 覆盖写 |
| 索引行 | isolate 内存 | 5min | 进程结束 |
| 解码向量 | isolate Map | 无（上限 5000 清空） | — |
| query 向量 | isolate Map | 无（上限 200 清空） | 只 isolate，不写 KV |
| 档案文本 | isolate | 5min | `appendArchiveLines` 置 null |
| 当日 context | isolate | 60s | 写入即 drop |
| rollups | isolate | 按 `count|max(updated_at)` key | 数据变则失效 |
| 天气 | D1 `runtime_state`（KV 兜底） | 30min | 过期后重新拉取，失败返回旧值 |

**为什么 query 向量不写 KV**：每句话都写会直接打爆免费 KV 写额度（1000/天），而命中率很低。

### 9.2 预算控制

| 位置 | 预算 | 超限行为 |
|---|---|---|
| prompt 长期记忆 | 24KB | 先降级旧事件区，再按日期裁 |
| compact 模式 | — | 只带 core + 稳定画像 |
| legacy 召回 | 6 条 + 每条裁剪 | 长条目只注入命中子句 |
| next 召回 | 2400 B | 整条丢弃，不截句 |
| 中期 | 8 条 | 取最后 8 条 |
| 短期 | 15/30/50 轮 + 字符预算 | 从最旧丢 |
| 归档提炼输入 | 60000 字 | 保留最新 |
| R2 双账号 | 8.5GB | 主账号满后新写入切小号；读取按模式（secondary 先读小号） |

### 9.3 降级矩阵

| 故障 | 表现 | 兜底 |
|---|---|---|
| KV 读失败 | 记忆为空 | 回源 R2 |
| R2 读失败 | 记忆为空 | `getMemory` 返回 `''`，聊天继续 |
| 索引读失败 | 无召回 | `recallMemoryForChat` catch → `''` |
| embedding 失败 | 关键词召回 | `embedTexts` 返回 `[]` |
| LLM 重排超时/失败 | 确定性排序 | 1.2s 超时或异常回退 |
| DeepSeek 提炼失败 | 条目没进本体 | 回退 Workers AI；仍失败则任务 failed、次日补跑 |
| Workers AI 返回空 | 同上 | 标记 `distill_error` |
| 搬档案失败 | 本体条目保留 | 写后验证不通过就中止 |
| 月度合并缺天 | — | 拒绝合并 |
| Memory Context 表未迁移 | legacy 正常 | 相关同步只打日志 |
| shadow/next 引擎异常 | 回复不变 | 吞异常，继续 legacy |

---

## 10. 排障手册

### 10.1 常用接口

| 用途 | 接口 |
|---|---|
| 就绪检查（表/开关/密钥） | `GET /api/admin/readiness` |
| 记忆规模与密度 | `GET /api/admin/stats` |
| 结构化记忆规模 | `GET /api/admin/memory/context-stats` |
| shadow/next 指标 | `GET /api/admin/engine-metrics?days=7` |
| 手动改完 R2 后刷缓存 | `POST /api/admin/memory/refresh` |
| 重建检索索引 | `POST /api/admin/memory/reindex` |
| 刷缓存 + 重建索引 | `POST /api/admin/memory/reload` |
| 重建 facts/events/chunks | `POST /api/admin/memory/rebuild-context` |
| 补 chunk 向量 | `POST /api/admin/memory/embed`（`{limit}`） |
| 回填来源 | `POST /api/admin/memory/backfill-provenance` |
| 从最近消息抽事实 | `POST /api/admin/memory/extract` |
| 任务队列 | `GET /api/admin/memory/jobs`、`POST /api/admin/memory/jobs/run` |
| 投影预览/写回 | `GET /api/admin/memory/projection`、`POST …/project`（`confirm:true`） |
| 手动周/月摘要 | `POST /api/admin/memory/rollup`（`{level, period}`） |
| 手动归档 | `POST /api/admin/run-daily` |
| 重建日志（不重提炼） | `POST /api/admin/rearchive-logs`（`{dates?, distill?}`） |
| 手动月合并 | `POST /api/admin/run-monthly` |

### 10.2 日志关键字

| 关键字 | 含义 |
|---|---|
| `[daily]` | 归档主流程（条目数/字节/提炼/去重/分层/补跑） |
| `[memory-index]` | 索引重建、embedding 失败、召回失败 |
| `[recall]` | LLM 重排（pool 大小、top 分、耗时、选中条数） |
| `[memo]` / `[summary]` | 中期/今日摘要刷新 |
| `[archive]` | 档案读写 |
| `[distill]` | DeepSeek 失败回退 Workers AI |
| `[storage]` | R2 容量/小号切换 |

trace 事件：`chat.context` / `openai.context`（模式、引擎、字节、召回条数）、`memory.engine`（新旧条数/字节/耗时/packedDropped）、`memory.engine.skip`、`memory.engine.error`。

### 10.3 常见症状 → 排查顺序

| 症状 | 先查 | 再查 |
|---|---|---|
| 模型“失忆”，不知道旧事 | `GET /api/admin/stats` 的 `memory_bytes` / `memory_prompt_mode` | 是否 compact；`memory_entries` 条数；召回日志 |
| 召回总是不命中 | `memory_entries_with_vec` 是否为 0 | `memory_duplicates` 是否过多（dup_of 误判）；tags/keywords 是否空 |
| 记忆没更新 | `cron_runs` 里昨天是否 `done` | `detail` 是否含“提炼错误”；`GET /api/admin/memory/context-stats` |
| 记忆“回滚”成旧版 | `storage:mode` 是否是 secondary | 小号 R2 里是否有新文件（secondary 模式先读小号，历史 bug已修） |
| 同一事实重复出现 | `stripDuplicateRecall` 是否生效 | 长期记忆里是否本来就有两份 |
| 归档后条目变少 | 是否触发 24KB 分层（看日志“记忆分层”） | 是否被 `compactMemoryEntries` 去重 |
| D1 消息被清但记忆没了 | 归档文件是否存在 | `cleanupOldMessages` 只在 done + 无提炼错误 + R2 有归档时删 |
| 摘要不更新 | `runtime_state` 里 `memo:24h` / `summary:*` | 锁是否残留（120s TTL 会自动释放） |

---

## 11. 已知不一致与待办

### 11.1 文档与代码不一致

| 项 | 文档说法 | 代码实际 |
|---|---|---|
| 短期轮数 | README/architecture 原写“最近 10 轮” | 默认 **15** 轮（技术 30、指代 50、上限 60）；**文档已于 2026-10-27 同步修正** |
| `jobs.ts` 5.7 注释 | “memory.md 不限大小、不压缩、不删除、不搬档” | 实际会去重，且 >24KB 时把旧条目分层到 archive.md（只搬不删） |
| 他的更正区位置 | 注释写“放在人物底色之后” | 实际插在**第一个 `##` 之前**（成为首个分区）；而 `reassemble` 会把未知分区排到文件末尾，因此下一次发生变更的重写（合并/去重/分层）后它会被挪到最后 |
| `enforceSectionBudgets` | 设计文档把它列为维护步骤 | 当前归档主流程未调用（走去重 + 分层）；同理 `ensureModuleComments`、`extractImmutableSection/injectImmutableSection` 目前只被单测覆盖 |
| `memory-archive.ts` 常量 | `ARCHIVE_KV_KEY` / `ARCHIVE_CACHE_TTL` | Phase 1 之后档案缓存只在 isolate，KV 常量已成残留 |

### 11.2 潜在风险点

1. **跨 origin 的 chunk 覆盖**：`buildMemoryChunks` 的 chunk id 是 `chunk_${fact.id}`；若 section/date/content 完全相同，`INSERT OR REPLACE` 会让 origin 被后写者覆盖（memory / conversation / archive 之间）。
2. **两套召回共存**：legacy 与 next 可能对同一事实各召回一次；靠 `contentHash` 与 `dup_of` 缓解，但没有统一去重。
3. **`dup_of` 是索引视图状态**：重新 reindex 时会重算；若语义阈值调低，可能把相关但不同的事实隐藏。
4. **`trimOldestEntries` 依赖日期前缀**：没有日期前缀的条目不会被裁，也不会参与过期/分层——新增条目必须带日期。
5. **`archive.md` 无上限**：append-only，长期会变大；检索侧有 `prepareArchive` 缓存（按首尾行+长度判变化），但极端规模下仍是 O(n) 打分。
6. **KV 索引体积**：`putIndexKv` 在载荷超过 **20MB**（`KV_INDEX_MAX_BYTES`，为 KV 单值 25MB 上限留余量）时丢弃向量；届时只能靠关键词召回，而 `/api/admin/stats` 里的 `memory_entries_with_vec` 读的是 D1，不代表 KV 里还有向量。

### 11.3 合理的下一步

**已完成（2026-10-27，随本文档一起整理）：**

- 修正 README / architecture / current-state / baseline 里“最近 10 轮”的过时表述；
- 在 README 与 architecture 的目录结构、记忆章节补上新增的 `memory-*.ts` / `recent-context.ts` / `context-packer.ts` / `runtime-store.ts`；
- 在 README 与 architecture 中加入本文档的入口链接。

**仍待处理（代码侧，需单独变更）：**

- 归档时补一次 `enforceSectionBudgets`（或删除该函数的“设计未落地”状态）；
- 给 `他的更正` 分区加进 `SECTION_ORDER`，避免下一次重写被 `reassemble` 挪到末尾；
- 为 chunk id 加 origin 前缀，消除跨 origin 覆盖；
- 若记忆继续增长，把 `recallMemoryForChat` 的全量扫描换成 D1 候选集/FTS 查询（代码注释里已预留 Phase 4 方向）。

---

## 12. 文件地图

| 关注点 | 文件 |
|---|---|
| `memory.md` 读写 + KV 缓存 | [`src/memory.ts`](../src/memory.ts) |
| legacy 索引 / 召回 / 向量量化 | [`src/memory-index.ts`](../src/memory-index.ts) |
| next 领域模型 / 排序 / RRF+MMR | [`src/memory-domain.ts`](../src/memory-domain.ts) |
| facts/events/chunks 持久化 | [`src/memory-context-store.ts`](../src/memory-context-store.ts) |
| 合并/去重/分层/预算/关系值 | [`src/memory-maintenance.ts`](../src/memory-maintenance.ts) |
| 档案层 | [`src/memory-archive.ts`](../src/memory-archive.ts) |
| 中期记忆 memo:24h | [`src/recent-memory.ts`](../src/recent-memory.ts) |
| 今日摘要 | [`src/summary.ts`](../src/summary.ts) |
| 短期原文 | [`src/recent-context.ts`](../src/recent-context.ts)、[`src/db.ts`](../src/db.ts) |
| 提炼 prompt 与模型回退 | [`src/distill.ts`](../src/distill.ts) |
| 每日归档 / 补跑 / D1 清理 | [`src/jobs.ts`](../src/jobs.ts) |
| 周/月摘要 | [`src/memory-rollups.ts`](../src/memory-rollups.ts) |
| 可重试任务 | [`src/memory-jobs.ts`](../src/memory-jobs.ts) |
| 显式纠正 | [`src/memory-correction.ts`](../src/memory-correction.ts) |
| 显式事实抽取 | [`src/memory-extract.ts`](../src/memory-extract.ts) |
| 雷区学习 | [`src/aversion.ts`](../src/aversion.ts) |
| 投影 | [`src/memory-projection.ts`](../src/memory-projection.ts) |
| 召回装包 | [`src/context-packer.ts`](../src/context-packer.ts) |
| prompt 装配 | [`src/prompt.ts`](../src/prompt.ts) |
| 聊天 / OpenAI / 主动消息 | [`src/chat.ts`](../src/chat.ts)、[`src/openai.ts`](../src/openai.ts)、[`src/webproactive.ts`](../src/webproactive.ts) |
| 引擎开关 | [`src/engine-flags.ts`](../src/engine-flags.ts) |
| 运行时状态（D1→KV 兜底） | [`src/runtime-store.ts`](../src/runtime-store.ts) |
| 双 R2 读写 | [`src/storage.ts`](../src/storage.ts) |
| 表结构 | [`schema.sql`](../schema.sql)、[`migrations/004-memory-context.sql`](../migrations/004-memory-context.sql)、[`migrations/005-memory-jobs.sql`](../migrations/005-memory-jobs.sql) |
| 初始模板 | [`memory-template.md`](../memory-template.md) |
| 评估集 | [`docs/eval/README.md`](./eval/README.md)、[`src/memory-eval.test.ts`](../src/memory-eval.test.ts) |

---

## 13. 一句话总结

> **用 R2 上的 markdown 当不可丢的本体，每天一次 LLM 提炼把对话沉淀成电报体条目；用 D1 索引 / 结构化表 / 周月摘要做可重建的检索视图；每轮只注入“核心 + 稳定画像 + 命中 top-k + 24h 纪要 + 最近若干轮原文”，再用跨层去重、字节预算、MMR、超时回退和全链路降级把 token 成本与故障面控制住。**
