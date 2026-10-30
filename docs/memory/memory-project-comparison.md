# 记忆项目对比

调研日期：2026-10-28

目的：对比候选开源项目的记忆/上下文设计，提炼可借鉴项；不直接替换 ds-memory 现有的事实源和观察期架构。

> 说明：LRC、HanakoPro、snowfox-memory-continuity、Companion-AI-Memory-Context-Token-Optimization 已读 README/设计文档；BaiShou-Next 的 clone 未完整拉取，仍标注“未确认”。Companion 目前主要是设计规范/提示词/示例，未包含宿主实现，不能当成已验证效果。

## 总览

| 项目 | 记忆模型 | 存储/检索 | 主要优点 | 主要代价 |
|---|---|---|---|---|
| LRC | 类型化记忆 + 事件/实体关联 + 结晶 | 本地 Rust 服务；语义编码 + HNSW；关联扩展；哈希链审计 | 关联不是纯相似度；可解释、可审计 | 本地服务较重；依赖记忆里写好关联字段 |
| HanakoPro | 会话摘要 → 原子事实 | SQLite facts + FTS5；CJK ngram；标签/时间 | 原子事实、去重简单、可前端管理 | 以全文检索为主；关系和长期演化较弱 |
| snowfox-memory-continuity | 分层 F0/L1/L2/L3/L4 | Markdown 文件 + 压缩/合并/退役脚本；L4 TF-IDF | 层级和 token 预算清晰；可人工维护 | 文件一致性/并发弱；语义检索有限 |
| BaiShou-Next | 未确认 | 未确认 | 未确认 | 未确认 |
| Companion-AI-Memory-Context-Token-Optimization | 热记忆 + 冷库 + 连续状态 | 设计规范；全量对话归档 + 逻辑索引 + 事件向量 | token 子预算、线索触发冷召回、渐进冷却 | 目前是设计方案，需宿主实现和实测 |

---

## 1. LRC

来源：

- https://github.com/zhibaiYingChuan/LRC
- 镜像：https://gitcode.com/gcw_M73FIiUo/LRC

### 记忆模型

- 写入时区分类型：`fact`、`preference`、`decision`、`code_context`、`conversation`、`experience`、`synthesis`。
- 每条记忆可带重要性（1–10）和隐私级别。
- 语义相近的记忆会聚类融合成“结晶”条目（程序记忆）；有 LLM 时由 LLM 归纳，否则用本地合成。
- 检索不是只做相似度：以召回结果为起点做**有界关联展开**。

### 关联来源

- 同一次经历：相同 `event_id`；
- 同一时段：同项目 + 时间窗口，标注 `auto:` 来源；
- 共享实体：同一文件/对象；
- 互相结晶：`derived_from` / `crystallized_into`；
- 符号层：图结构推导的因果/时序/约束，明确标注“结构推导”，不当作事实。

### 检索与审计

- 代码索引与记忆检索是两条独立链路；代码用 HNSW，记忆检索可用语义编码。
- 记忆增删改和联想足迹写入 SHA256 哈希链，另有封印文件防篡改。
- 关联只对已召回结果展开，不扩张检索根集；复用隐私/项目/类型过滤，避免关联绕过权限。

### 可借鉴

1. **显式关联字段**：`event_id`、实体、`derived_from`，比单纯向量相似度更能解释“为什么想起这个”。
2. **关联来源分层**：记录层（必然成立）与符号层（可能成立）分开标注，不混淆可信度。
3. **审计链**：记忆修改可追溯；ds-memory 目前只有来源/时间，缺少防篡改审计。
4. **只对召回结果做有界扩展**：控制成本，不让联想无限扩散。

### 不建议照搬

- 引入完整 Rust 本地服务和 HNSW 代码索引，超出当前 Worker 架构。
- 依赖用户手工写 `event_id` 才有好效果；ds-memory 应尽量自动生成事件边界。
- 符号层因果推断在真实召回中读回率很低，优先级应低。

---

## 2. HanakoPro

来源：https://github.com/ZS520L/HanakoPro

### 记忆模型

- 以 session 为单位生成摘要；摘要有 snapshot，只有 `summary !== snapshot` 的脏 session 才进入深度提炼。
- LLM 将摘要 diff 拆成**原子事实**，每条带 tags 和 time。
- FactStore 用 SQLite：
  - `facts` 表保存 fact、search_text、tags、time、session_id；
  - FTS5 全文索引；
  - 中文用 CJK ngram 生成检索 token；
  - 不使用 embedding/vector/score/decay/hit_count（v2 明确简化）。
- 前端支持分条展示、跳转到对应对话、增删改。

### 可借鉴

1. **脏 session + snapshot diff**：只处理新增内容，避免每天重复提炼同一段摘要。
2. **原子事实**：一条记忆只表达一个事实，便于去重、合并和引用。
3. **FTS + CJK ngram 兜底**：向量召回失败时仍能按关键词找回；比纯向量更可控。
4. **用户可见/可管理**：记忆不是黑盒，前端能看、能改、能跳回来源。

### 不建议照搬

- 完全放弃向量/语义召回；ds-memory 的关键词+向量混合更适合跨表达召回。
- 只靠 session 摘要 diff；长对话里细节可能已被摘要压掉。
- 每条事实都调用 LLM 提炼，成本和延迟需要控制。

---

## 3. snowfox-memory-continuity

来源：https://github.com/TNong611/snowfox-memory-continuity

### 记忆模型

分层文件：

```text
F0 fixed.md      固定记忆，永不压缩
L1 recent.md     完整近期对话
L2 summary.md    中期摘要
L3 long_term.md  长期记忆
L4 archive.md    归档
user.md / tasklog.md / _assembled_context.md
```

脚本负责：

- L1→L2：LLM 摘要；
- L2→L3：LLM 二次蒸馏，去空、去重、去时间戳；
- L3→L4：纯搬运；
- L3/L4 重复记忆合并 + 权重标记；
- 组装上下文快照 `_assembled_context.md`。

容量参数集中配置，例如 L1 50 条/45KB、L2 100 条/30KB、L3 50 条/45KB。

### 可借鉴

1. **明确分层和容量预算**：每层有 token/条数上限，超出就压缩/退役。
2. **固定记忆与可压缩记忆分离**：F0 永不压缩，适合称呼、底线、长期偏好。
3. **合并/去重脚本化**：重复记忆不是靠模型每次即兴处理。
4. **组装上下文快照**：可复查“这一轮到底带了哪些记忆”。
5. **任务日志**：tasklog 适合记录进行中事项，而非混进用户画像。

### 不建议照搬

- 纯 Markdown 文件 + 脚本的一致性/并发能力弱；多端同时写容易冲突。
- L4 仅 TF-IDF，跨语义召回不足。
- 分层过多会增加维护和调试成本；ds-memory 已有日/周/月 rollup，可映射而不是照搬五层。

---

## 4. BaiShou-Next（未确认）

来源：https://github.com/foxletters-hq/BaiShou-Next

当前 clone 未完整拉取，仓库内容未读到；不做实现判断。

后续需要补：

- README 与目录结构；
- memory/context 相关源码；
- 是否有分层、检索、摘要或 token 预算设计。

---

## 5. Companion-AI-Memory-Context-Token-Optimization

来源：https://github.com/ARCHEON999/Companion-AI-Memory-Context-Token-Optimization

### 定位

这是一个面向 Companion/Coopanion 的**设计规范 + 提示词 + 示例配置**仓库，不是宿主实现；README 也明确“尚未接入真实对话、没有实测节省比例”。因此只借鉴机制，不把它的参数当作已验证最优值。

### 记忆模型

- **热记忆**：当前上下文只放
  - 用户固定事实；
  - 相关活跃记忆；
  - 当前线索召回的少量条目；
  - 近期历史窗口。
- **冷库**：所有对话原文都归档，按类型、时间、地点、人物、物品、话题建立逻辑索引。
- **渐进冷却**：
  - 近期细节 → 短摘要 → 冷库；
  - 不因为“到点”整段播下；
  - 性格底色和当前相处基线不随旧事件冷却。
- **线索触发冷召回**：只有用户明确提到相关人/时间/地点/物品/话题才查冷库；普通问候、定时提醒、模型自己想起不能触发。
- **事件向量**：每个事件可存语义向量；关联度按当前问题重算，冷召回不叠加“距今年代”的衰减。
- **连续状态**：基础性格、近期状态、未说完的话和少量具体细节跨天保留，旧状态版本进历史。

### token 预算

README 的初始建议：

```text
每请求记忆总块：1,600 tokens
固定事实：160 tokens / 4 条
活跃记忆：960 tokens / 8 条，每主题最多 2 条
当前线索召回：480 tokens / 3 条
近期历史窗口：2,000 tokens / 最多 6 个完整交互
```

子预算不可互相借用，没用完就留空；固定事实和当前任务不能无限增长。

### 可借鉴

1. **子预算不可互相借用**：比“总预算一刀切”更能控制某类记忆膨胀。
2. **线索触发冷召回**：避免模型每轮主动翻旧账，降低 token 和上下文污染。
3. **渐进冷却**：细节→摘要→冷库，保留“自然过渡”，不突然失忆。
4. **逻辑索引**：类型/时间/地点/人物/物品/话题多入口，弥补纯向量召回。
5. **冷召回不做年龄惩罚**：久远但被明确提起的事也要能找回。
6. **连续状态预算**：性格底色和近期状态单独占预算，不跟普通事件一起被淘汰。

### 不建议直接照搬

- 当前仓库没有宿主实现，不能直接当依赖；
- 1,600 tokens 等参数未实测，需按 ds-memory 的上下文长度重新标定；
- 多入口索引和事件向量会增加写入/维护成本，应先用回归集验证；
- “线索模糊时让用户补充一句”适合聊天，但不适合所有 App 场景。

### 对 ds-memory 的启发

- 现有 `context-budget.ts` 可以进一步把“固定事实/近期/rollup/召回”做成不可互借的子预算；
- 冷库召回应加“用户明确线索”门槛，不要让主动消息或普通问候触发；
- 归档已有全量原文，下一步可补逻辑索引，而不是只靠向量；
- 事件向量可以复用现有 chunks，但需要独立测试冷召回质量。

---

## 与 ds-memory 当前架构对比

ds-memory 当前：

```text
R2 memory.md                 事实源/长期记忆
D1 messages                  原始对话
D1 memory_facts              结构化事实
D1 memory_events             事件
D1 memory_chunks/entries     检索索引
D1 memory_rollups/summaries  周/月摘要
关键词 + 向量混合召回
日归档 + 周/月摘要
关系/情绪系统
MEMORY_ENGINE_* 影子/legacy
```

相对优势：

- 事实源明确，可人工修正；
- 已有归档、摘要、向量、关系/情绪多条链路；
- 有 shadow 观察机制，可渐进切换。

相对不足：

- 记忆之间缺少显式关联（事件/实体/因果）；
- 缺少记忆修改审计链；
- 原子事实粒度不如 HanakoPro；
- 分层容量预算不如 snowfox 明确；
- 记忆可解释性/来源可视化不足。

## 借鉴优先级

### P0：事件/实体关联与来源

- 在 `memory_facts` / `memory_entries` 增加 `event_id`、`entities`、`derived_from`（可先 JSON 字段）；
- 召回时对已召回结果做有界关联扩展；
- 结果标注“同事件/同实体/同项目/推导”，不混入排序分数。

理由：直接改善“为什么想起这个”，且不改变 memory.md 事实源。

### P1：原子事实 + 去重/合并

- 归档提炼输出原子事实，而不是长段落；
- 用内容 hash/近重复合并；
- 保留来源消息 id，支持跳回原文。

理由：HanakoPro 的 snapshot diff 和原子事实能降低重复与上下文污染。

### P1：分层预算与组装快照

- 给 memory.md 核心、近期摘要、周/月 rollup、召回片段设 token/字符预算；
- 每轮记录实际注入了哪些块（可调试快照）；
- 固定记忆（称呼、底线、长期偏好）单独标记，不参与压缩。

理由：snowfox 的容量控制能避免上下文膨胀。

### P2：审计与可追溯

- 记录记忆新增/修改/删除的来源、时间、操作者；
- 先做轻量审计表，不必上哈希链；
- 后续再评估防篡改。

### P2：FTS/关键词兜底

- 现有 chunks 已有关键词；可补 SQLite FTS 或 CJK ngram 兜底；
- 不替代向量召回，只做低分/无向量时的回退。

## 不建议照搬

- 引入 LRC 的本地 Rust 服务/HNSW 代码索引；
- 用 HanakoPro 完全替代向量召回；
- 照搬 snowfox 的五层文件和脚本链；
- 在观察期内切换 `MEMORY_ENGINE_*` 到 `next`；
- 没有来源和回滚方案就自动删除/覆盖记忆。

## 参考链接

- LRC: https://github.com/zhibaiYingChuan/LRC
- LRC 镜像: https://gitcode.com/gcw_M73FIiUo/LRC
- HanakoPro: https://github.com/ZS520L/HanakoPro
- snowfox-memory-continuity: https://github.com/TNong611/snowfox-memory-continuity
- BaiShou-Next: https://github.com/foxletters-hq/BaiShou-Next
- Companion-AI-Memory-Context-Token-Optimization: https://github.com/ARCHEON999/Companion-AI-Memory-Context-Token-Optimization

## 已落地（2026-10-28）

第一阶段已实现，且只在 shadow/next 记忆引擎路径启用：

- `memory_links`：事实→同实体事实、事实→同日事件；
- `linkFactToNeighbors()`：新事实写入时自动建关联；
- `linkAllFacts()`：重建上下文后补齐存量关联；
- `expandLinkedChunks()`：只从已召回结果扩 1 跳，最多补 2 条；
- `memory_audit`：`/更正` 写入前后 hash、来源和内容；
- `memory.engine` trace 增加 `linkedItems`；
- 现有 `canonicalizeFacts()` 已经承担同槽位去重和来源合并，暂不另造一套原子事实表。

当前 D1 实测：87 条关联（同实体 33、同事件 54）。

下一步仍待做：

- 上下文分层预算；
- 原子事实的跨日期近重复合并（现有 canonicalize 主要按槽位）；
- FTS/CJK 兜底；
- 记忆查看/编辑 UI。
