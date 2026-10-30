# 记忆与关系系统重构 · 任务目标报告

> 版本：v0.1（评审稿）  
> 日期：2026-10-24  
> 范围：`ds-memory`（Cloudflare Worker）为主，`ds-qq-client`（手机端）只做兼容性配合  
> 状态：八项决策已确认（2026-10-24），等待启动 Phase 0  
> 目标读者：项目所有者、后续维护者、参与实现的 AI Agent

---

## 决策记录（已确认，2026-10-24）

| # | 决策 | 已确认结论 | 执行影响 |
|---|---|---|---|
| D1 | 关系轴 | **保留 5 轴**（好感/亲密/信任/尊重/心动） | 不改现有语义；prompt 只输出定性；Phase 3 按 5 轴建账本 |
| D2 | 鉴权 | **无状态签名 Cookie（24h）+ `AUTH_SECRET` + 很小的 D1 吊销表（全部登出）** | 去掉轮询鉴权的 KV 读；Phase 1 实现；上线需重新登录一次 |
| D3 | 网页轮询 | **默认 20 秒 + 隐藏暂停 + 可见/聚焦/发送后立即补拉** | 不刷新页面也能显示新聊天；优先省请求；可配置为 10s |
| D4 | `memory.md` | **投影 + 人工 pinned 区** | facts/events 为真相；`memory.md` 为快照/导出；手改走 pinned |
| D5 | 切换顺序 | **QQ 先切 → 网页 → 主动消息** | QQ 主链路优先验证；必须配 shadow、远程日志、kill switch |
| D6 | 情感披露 | **单人自用，跳过用户可见披露**；保留 prompt 行为边界 | 不做 onboarding/关于页常驻说明；仍不宣称真实意识、不施压 |
| D7 | 工期 | **完整 8~12 周，一次做完** | 阶段门禁保留为质量门，不作为审批门 |
| D8 | 预算 | **纯免费，不升级付费** | Phase 1 KV 瘦身是硬前置；额度触顶时降级/暂停非核心，不引入付费依赖 |

> 说明：D6 的“跳过披露”只去掉用户可见说明；prompt 层的安全边界仍保留，因为它约束的是角色行为（不宣称真实意识、不用离开/痛苦施压），不是产品免责声明。

---

## 目录

- 决策记录
- 0. 摘要
- 1. 背景与现状
- 2. 最终目标
- 3. 设计原则
- 4. 目标架构
- 5. 阶段与任务
- 6. 验证体系
- 7. 里程碑与工期
- 8. 风险登记
- 9. 上线与回滚
- 10. 已确认决策
- 11. 附录

---

## 0. 摘要

本报告把当前项目从「能跑的个人 AI 伴侣」重构为「可长期维护、可评估、可回滚、成本可控的记忆与关系系统」。

最终目标不是简单地上 RAG，也不是把代码写得更漂亮，而是建立三个清晰的能力边界：

1. **Memory Context**：记得什么、记得多准、能否追溯来源；
2. **Relationship / Affect Context**：好感度、亲密度、心情、态度如何演化，为什么这样演化；
3. **Conversation Context**：这一轮到底带哪些记忆、什么态度、多少 token。

核心约束：

- 单用户、私人部署；
- Cloudflare 免费/低成本额度；
- KV 不能再承担高频状态（当前免费额度：读 10 万/天、写 1 千/天、删 1 千/天）；
- 现有 631 个 Worker 测试必须持续通过；
- 手机端 NapCat/媒体链路暂不重写，只保证兼容；
- 情感是模拟状态，不宣称真实意识。

---

## 1. 背景与现状

### 1.1 两套代码

| 代码 | 位置 | 职责 |
|---|---|---|
| `ds-memory` | Cloudflare Worker + Hono + TS | 记忆、人设、关系/情绪、主动消息、网页聊天、OpenAI 兼容端点、cron |
| `ds-qq-client` | Termux/Android + Python | NapCat/OneBot 接入、QQ 私聊、媒体解析、TTS、配置页 |

手机端目前已经通过 `inject_history=true` 让 Worker 补最近 10 轮，因此第一阶段的记忆重构不需要改手机端协议。

### 1.2 当前记忆/关系链路

```text
QQ / 网页 / AstrBot
        ↓
Worker：鉴权 → 取 memory.md → 取 10 轮历史 → memo/摘要 → 召回
        ↓
组装：核心记忆 + 最近 10 轮 + 召回 + 关系/情绪状态
        ↓
DeepSeek → 回复 → 落 D1 → 异步摘要/提炼
        ↓
每日 04:00：归档 R2 → 提炼 memory.md → 重建索引 → 关系/情绪结算
```

已具备的能力：

- 10 轮短期记忆（按 `turn_id` 分组、带时间戳）；
- `memory.md` 长期记忆 + R2 档案；
- D1 `memory_entries` 关键词 + 向量召回；
- `memo:24h` 中期记忆；
- 5 轴关系 + 8 维情绪 + 情感事件 + 态度策略；
- 主动消息、归档、补跑、月度合并；
- 631 个 Worker 测试。

### 1.3 当前主要问题

| 问题 | 现象 | 影响 |
|---|---|---|
| KV 被当数据库用 | 鉴权、情绪、心跳、摘要锁、向量缓存都走 KV | 免费额度易耗尽，读写都受限 |
| 状态分散 | 关系值在 `memory.md`，情绪在 KV，态度在代码里派生 | 难解释、难回放、难迁移 |
| 记忆与关系耦合 | 关系值写进长期记忆，召回与情绪互相影响 | 一改就牵连，容易回归 |
| 索引全量重建 | 每天扫描 `memory.md + archive.md` | 记忆变多后变慢 |
| RAG 工程化不足 | 单路 query、分数直接相加、无来源追溯 | 召回质量和可调试性有限 |
| 缺少评估 | 没有 golden query、召回指标、行为回归集 | 只能凭感觉调参 |
| 文档漂移 | 尺寸、测试数、归档行为多处不一致 | 维护成本高 |
| 情感边界不清 | 数值和态度混在 prompt 里 | 容易过度、难解释、伦理风险 |

### 1.4 约束

- Cloudflare KV 免费额度：读 100,000/天、写 1,000/天、删 1,000/天、List 1,000/天、存储 1GB；
- D1 免费额度：读 5,000,000 行/天、写 100,000 行/天、存储 5GB；
- Workers 免费请求数、CPU、单次子请求数（50）都需要考虑；
- 单用户，不需要多租户隔离，但数据模型保留 `user_id` 扩展位；
- 不允许为了重构牺牲现有可用性。

---

## 2. 最终目标

### 2.1 一句话目标

> 把记忆与关系从「散落在 KV、R2、代码和 prompt 里的状态」重构为「以 D1/R2 为真相、以事件账本为审计、以派生快照为读模型、以策略层为表现」的可评估系统。

### 2.2 目标状态

#### Memory Context

- 原始消息 append-only，永久可追溯；
- 事实、事件、摘要、索引分层；
- `memory.md` 只是「策展视图/快照」，不是唯一真相；
- 索引可重建、可增量更新；
- 召回带来源、时间、置信度；
- 小记忆全量注入，大记忆混合召回；
- 归档失败可自动补跑，不丢天。

#### Relationship / Affect Context

- 5 轴关系：好感度、亲密度、信任、尊重、心动；
- 心情由 8 维情绪向量派生，不独立维护；
- 所有数值变化有事件账本：原因、来源、置信度、上限；
- 态度是每轮派生的策略输出，不是持久化数值；
- 可解释、可重置、可回放；
- 情感是模拟状态，不宣称真实意识；
- 有安全边界：不惩罚用户、不用离开/痛苦施压。

#### Conversation Context

- 最近 10 轮按时间从旧到新，带时间戳；
- 核心人设 + 关系快照 + 短期历史 + 中期 memo + 召回片段按预算组装；
- 数值不进 prompt，只进定性指令；
- 每轮有 trace：注入了什么、为什么、多少 token、耗时。

#### 工程与运维

- KV 只保留低频配置/可选缓存，目标读 < 5,000/天、写 < 100/天；
- D1 写入 < 50,000 行/天；
- 关键路径有 feature flag、影子模式和回滚开关；
- 631 个现有测试持续通过，新增测试覆盖新边界；
- 文档、迁移、runbook 同步。

### 2.3 验收指标（初始目标，按基线校准）

| 维度 | 指标 | 目标 |
|---|---|---|
| 记忆可靠性 | 归档丢失天数 | 0 |
| 记忆可靠性 | 提炼失败自动补跑成功率 | ≥ 99% |
| 召回质量 | golden set recall@6 | 不低于旧路径，目标 ≥ 0.85 |
| 召回质量 | 注入片段精确率 | ≥ 0.75 |
| 记忆密度 | 单轮注入记忆字节 | 不高于旧路径 120% |
| 关系一致性 | 数值边界/日上限/防重复计数 | 100% 通过不变量测试 |
| 解释性 | 能解释最近一次态度变化 | 100% |
| 安全 | 操纵/依赖诱导测试 | 0 条违规话术 |
| 性能 | 召回 p95 | < 300ms |
| 性能 | 首字 p95 | < 3s（以基线校准） |
| 成本 | KV 读/写 | 见目标状态 |
| 稳定性 | 测试 | 631 + 新增全绿 |

### 2.4 非目标

- 不做多用户/多租户；
- 不重写 NapCat、proot、手机端媒体链路；
- 不在第一期上 GraphRAG、Vectorize、复杂知识图谱；
- 不让 LLM 每轮直接改关系数值；
- 不把 `memory.md` 完全删除（保留为导出/快照/人工可读视图）；
- 不承诺“真实意识”或“真实情感”。

---

## 3. 设计原则

1. **API 契约稳定**：`/api/chat`、`/v1/chat/completions`、`/api/proactive/*` 行为不先变。
2. **渐进式重构**：原地模块化 + Strangler，不做 big-bang rewrite。
3. **D1/R2 为真相，KV 为缓存**：高频状态不进 KV。
4. **事件账本 + 派生快照**：数值可重建，变更可审计。
5. **只做加法迁移**：先加表/列/双写，最后删旧。
6. **影子运行**：新引擎先对比，再切读。
7. **单一写入方**：关系/情绪只经 `AffectService`，记忆只经 `MemoryService`。
8. **数值不进 prompt**：只输出定性指令。
9. **可解释**：每次态度变化有 reason/evidence/policy_version。
10. **可回滚**：feature flag + 旧表保留 + 备份。
11. **安全优先**：不宣称真实意识、不用离开/痛苦施压；单人自用可省略用户可见披露，但保留 prompt 行为边界。
12. **观测先于优化**：没有 trace 和评估集，不调参。

---

## 4. 目标架构

### 4.1 系统分层

```text
┌──────────────────────────────────────────────┐
│ API 层（保持契约）                            │
│  web / openai / admin / queue                 │
└──────────────────────┬───────────────────────┘
                       ▼
┌──────────────────────────────────────────────┐
│ Application 层（用例）                        │
│  SendMessage / ArchiveDay / Consolidate       │
│  RecallMemory / BuildAttitude / Reindex       │
└──────────────────────┬───────────────────────┘
                       ▼
┌──────────────────────────────────────────────┐
│ Domain 层（纯函数）                           │
│  Memory / Relationship / Emotion / Persona    │
│  Conversation / Proactive / Policy            │
└──────────────────────┬───────────────────────┘
                       ▼
┌──────────────────────────────────────────────┐
│ Ports                                        │
│  MessageStore / FactStore / EventStore        │
│  SummaryStore / RawStore / Cache / LLM        │
│  Clock / IdGenerator / LockStore              │
└──────────────────────┬───────────────────────┘
                       ▼
┌──────────────────────────────────────────────┐
│ Adapters                                      │
│  D1 / R2 / KV（仅低频） / DeepSeek / Workers AI│
└──────────────────────────────────────────────┘
```

### 4.2 限界上下文

| 上下文 | 负责 | 不负责 |
|---|---|---|
| Memory | 事实、事件、摘要、索引、召回 | 不直接改关系值 |
| Relationship/Affect | 关系账本、情绪账本、态度策略 | 不直接改事实 |
| Conversation | 10 轮历史、上下文预算、prompt 组装 | 不持久化业务状态 |
| Persona | 角色底色、性格漂移、称呼 | 不直接改关系 |
| Proactive | 主动消息决策、队列、反馈 | 不直接改记忆 |
| Billing | LLM 成本、token | 不参与行为 |

### 4.3 目标数据模型

```sql
-- 原始消息（已有，append-only）
messages(id, role, content, turn_id, turn_type, reply_to_id,
         channel, proactive_kind, cost_rmb, prompt_tokens,
         completion_tokens, date_key, created_at, created_ms)

-- 记忆事实
memory_facts(
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL DEFAULT 'owner',
  section TEXT NOT NULL,
  subject TEXT,
  predicate TEXT,
  object TEXT,
  content TEXT NOT NULL,
  valid_from TEXT,
  valid_to TEXT,
  confidence REAL NOT NULL DEFAULT 1,
  source_message_ids TEXT,
  tags TEXT,
  content_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)

-- 记忆事件
memory_events(
  id TEXT PRIMARY KEY,
  date_key TEXT NOT NULL,
  summary TEXT NOT NULL,
  participants TEXT,
  emotions TEXT,
  source_message_ids TEXT,
  created_at INTEGER NOT NULL
)

-- 记忆摘要（日/周/月）
memory_summaries(
  id TEXT PRIMARY KEY,        -- day:YYYY-MM-DD / week:... / month:...
  level TEXT NOT NULL,
  period TEXT NOT NULL,
  content TEXT NOT NULL,
  source_ids TEXT,
  created_at INTEGER NOT NULL
)

-- 派生索引（可重建）
memory_chunks(
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,       -- fact/event/summary/archive
  section TEXT,
  content TEXT NOT NULL,
  date TEXT,
  keywords TEXT,
  tags TEXT,
  importance INTEGER DEFAULT 2,
  vec TEXT,
  content_hash TEXT,
  updated_at INTEGER
)

-- 关系账本
relationship_events(
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  axis TEXT NOT NULL,         -- affection/intimacy/trust/respect/attraction
  delta REAL NOT NULL,
  reason TEXT NOT NULL,
  source_message_ids TEXT,
  confidence REAL NOT NULL,
  policy_version TEXT NOT NULL,
  applied INTEGER NOT NULL DEFAULT 1,
  cap_hit INTEGER NOT NULL DEFAULT 0
)

-- 关系快照（可重建）
relationship_state(
  id INTEGER PRIMARY KEY CHECK (id = 1),
  affection INTEGER NOT NULL,
  intimacy INTEGER NOT NULL,
  trust INTEGER NOT NULL,
  respect INTEGER NOT NULL,
  attraction INTEGER NOT NULL,
  version INTEGER NOT NULL,
  computed_at INTEGER NOT NULL,
  inputs_hash TEXT NOT NULL
)

-- 情绪事件 / 快照
emotion_events(
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  intensity INTEGER NOT NULL,
  target TEXT,
  evidence TEXT,
  resolved INTEGER DEFAULT 0,
  source_message_ids TEXT,
  decay_at INTEGER
)

emotion_state(
  id INTEGER PRIMARY KEY CHECK (id = 1),
  vector TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  version INTEGER NOT NULL
)

-- 态度快照（审计用，不是输入真相）
attitude_snapshots(
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  archetype TEXT NOT NULL,
  dominant_emotions TEXT NOT NULL,
  directives TEXT NOT NULL,
  reasons TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  inputs_hash TEXT NOT NULL
)

-- 运行时状态（替代高频 KV）
runtime_state(
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER
)

-- 异步任务（替代 KV 锁）
memory_jobs(
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,          -- extract/archive/consolidate/reindex
  target TEXT,
  status TEXT NOT NULL,        -- queued/running/done/failed
  attempts INTEGER DEFAULT 0,
  run_after INTEGER,
  lease_until INTEGER,
  detail TEXT,
  created_at INTEGER,
  updated_at INTEGER
)

-- 非聊天 LLM 成本
llm_costs(
  date_key TEXT PRIMARY KEY,
  cost_rmb REAL NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
)
```

### 4.4 存储分工

| 存储 | 用途 | 不存 |
|---|---|---|
| D1 | 消息、事实、事件、摘要、关系/情绪账本、运行时状态、任务、成本 | 大文件、原始图片 |
| R2 | 原始归档、`memory.md` 快照、档案、图片 | 高频状态 |
| KV | 可选低频配置/开关/边缘缓存 | 心跳、情绪、锁、摘要、向量缓存 |
| isolate 内存 | 热缓存：memory core、index、config、weather | 唯一真相 |

### 4.5 API 契约

保持不变：

- `POST /api/chat`
- `POST /v1/chat/completions`
- `GET /api/history/since`
- `GET/POST /api/proactive/*`
- `GET /api/admin/*`

新增（可选）：

- `GET /api/admin/trace/:turnId`
- `GET /api/admin/relationship/timeline`
- `POST /api/admin/relationship/explain`
- `POST /api/admin/relationship/reset`
- `GET /api/admin/memory/diagnose`
- `GET /api/admin/kv-audit`

---

## 5. 阶段与任务

> 说明：每个任务都包含「实现计划」和「验证」。阶段验收不通过，不进入下一阶段。  
> 工期按单人开发估算，不含长期观察和调参；可与评审并行调整。

### 5.0 执行规则

- **任务粒度**：一个任务应能在 1~3 天内完成并独立验证；超过 3 天就继续拆。
- **任务编号**：`P<阶段>-T<序号>`，每个任务必须有实现计划、验证方式、产出物。
- **WIP 限制**：同一时间只推进 1 个编码任务 + 1 个验证/评审任务，避免半成品堆积。
- **阶段门禁**：上一阶段验收未通过，不进入下一阶段；确需并行，必须明确独立边界和回滚方案。
- **变更控制**：任何超出本报告范围的需求，先更新报告和决策记录，再排期。
- **每次合并**：`tsc --noEmit` + 全量测试 + 变更说明；涉及 KV/D1 的任务额外附用量对比。
- **评审节奏**：每个 Phase 结束做一次 30 分钟评审：目标是否达成、指标是否达标、风险是否可接受、下一阶段是否放行。

---

### Phase 0：基线与安全网

**目标**：在动任何业务逻辑之前，建立可回滚、可观测、可评估的基线。

**前置**：无。

| ID | 任务 | 实现计划 | 验证 | 产出 |
|---|---|---|---|---|
| P0-1 | 现状清单与边界 | 盘点 Worker 路由、cron、KV key、R2 对象、D1 表；标出 legacy/new；写 `docs/current-state.md` | 清单覆盖所有 `env.KV`/`env.DB`/R2 调用；人工 review | 现状文档 |
| P0-2 | 行为基线与 characterization tests | 为 10 轮历史、归档、摘要、召回、关系/情绪不变量、API 契约补测试；保存 fixture | 631 + 新增全绿；关键行为有快照 | 测试基线 |
| P0-3 | 观测与 trace | 每轮记录 request_id、channel、memory_mode、recall_ids、注入字节、关系/情绪快照、耗时、错误；落 D1 或结构化日志 | 一次聊天可在 admin 看到完整 trace；无敏感信息泄漏 | trace 能力 |
| P0-4 | 备份与回滚演练 | D1 export/Time Travel、R2 snapshot、上一版本 Worker 部署包；写 runbook | 实际恢复一次；记录 RTO/RPO；回滚开关可用 | 回滚预案 |
| P0-5 | golden set 与场景集 | 50 条记忆 query + 20 个关系/情绪场景 + 10 个安全场景；记录期望事实/行为 | 基线指标可计算；评审通过 | 评估集 v1 |

**阶段验收**：

- 631 测试全绿；
- 任意一轮可追踪；
- 可在 10 分钟内回滚；
- golden set 有基线分数。

**风险**：测试补太多、范围失控。控制：只补关键路径，不追求全覆盖。

---

### Phase 1：存储接缝与 KV 瘦身

**目标**：不改记忆行为，把高频状态迁出 KV，降低额度风险。

**前置**：Phase 0 完成。

| ID | 任务 | 实现计划 | 验证 | 产出 |
|---|---|---|---|---|
| P1-1 | 存储端口抽象 | 定义 `MessageStore`、`RawStore`、`CacheStore`、`LockStore`、`CostStore` 接口；现有 D1/R2/KV 调用逐步收口 | 端口层单测；旧调用点清单归零；631 测试通过 | 可替换存储层 |
| P1-2 | D1 `runtime_state` | 建表 + 迁移；心跳、暂停、离线提醒、profile dirty、weather、成本、锁逐步迁入 | 对照测试；读写路径不再走 KV；24h soak | 运行时状态 D1 化 |
| P1-3 | 无状态鉴权 | 登录签发 HMAC 签名 Cookie（`exp` + nonce）；Worker 验证签名，不读 KV；登出清 Cookie；`AUTH_SECRET` 可轮换；D1 `auth_revocations` 只处理「全部登出」 | 登录/登出/过期/伪造 token 测试；全部登出后旧 Cookie 失效；`/api/history/since` 不再 KV 读 | KV 鉴权读归零 |
| P1-4 | 网页轮询优化 | 默认 20s（可配置 10s）；隐藏标签页停止；可见/聚焦/发送后立即补拉；流式期间暂停；不刷新页面也能显示新消息 | 24h 请求计数对比；后台/前台切换；跨渠道新消息 20s 内出现；无重复渲染 | 读请求下降 |
| P1-5 | 清理低价值 KV | 删除 `qvec` KV 缓存（保留 isolate LRU）；`archive:cache` 改 isolate/R2；`memory:index` 改 isolate + D1 回源 | KV 读写统计对比；冷启动召回正确；延迟不退化 | KV 缓存精简 |
| P1-6 | KV 审计与配额保护 | `/api/admin/kv-audit`；按 key 统计读写；接近阈值自动关闭可选缓存并告警 | 模拟超限；降级路径可用；告警可见 | KV 可观测 |

**阶段验收**：

- KV 读 < 5,000/天、写 < 100/天（目标，按实际流量校准）；
- D1 写 < 50,000/天；
- 631 测试全绿；
- 登录、聊天、主动消息、归档行为不变；
- 回滚开关可恢复旧鉴权/旧存储路径。

**风险**：无状态 token 无法单独吊销；轮询变慢影响体验。  
**缓解**：24h TTL + D1 吊销表（全部登出）；轮询间隔可配置（默认 20s，可回 10s）。

---

### Phase 2：Memory Context 抽离

**目标**：把记忆从 Worker 各模块抽成独立上下文，建立事实/事件/摘要/索引分层。

**前置**：Phase 1 完成。

| ID | 任务 | 实现计划 | 验证 | 产出 |
|---|---|---|---|---|
| P2-1 | 记忆领域模型 | 定义 `MemoryFact`、`MemoryEvent`、`MemorySummary`、`MemoryChunk`、`Provenance`、`Validity`；纯函数不依赖 Cloudflare | 单测覆盖序列化/校验/不变量；类型检查 | domain 层 |
| P2-2 | D1 记忆 schema | 新增 `memory_facts/events/summaries/chunks`；加法迁移；保留旧 `memory_entries` | 迁移可重复执行；新表写入/读取测试 | 新数据模型 |
| P2-3 | 写入与提炼管线 | `ArchiveDay` → 提取事实/事件 → 去重/冲突/有效期 → `memory_jobs` 异步重试；幂等键 | 回放 7 天历史；重复任务不重复写；失败可重试 | 记忆写入链路 |
| P2-4 | 读取与召回管线 | `RecallMemory`：query 改写/过滤 → 关键词 + 向量 → RRF → MMR → 重排 → token 预算；返回 provenance | golden set recall/precision；无命中返回空；延迟达标 | 召回服务 |
| P2-5 | `memory.md` 投影 | 从 facts/events/summaries 生成 `memory.md` 快照；保留人工可读/导出；写入 R2 前校验 | 投影与源数据一致性测试；人工 review；回滚可恢复 | 快照机制 |
| P2-6 | 双写与影子对比 | 旧路径继续写 `memory.md`；新路径写 D1；shadow 模式后台计算新召回，记录对比 | 影子运行 7 天；新旧召回差异报告；无 P0 回归 | 切换依据 |

**阶段验收**：

- 新路径 shadow 召回在 golden set 上不低于旧路径；
- 无重复/过期事实进入 prompt；
- 每轮注入 token 不高于旧路径 120%；
- 召回 p95 < 300ms；
- 旧路径可随时回滚。

**风险**：抽取质量不稳定、事实冲突、D1 写入放大。  
**缓解**：规则优先 + LLM 仅处理歧义；写前校验；批量写入；保留旧路径。

---

### Phase 3：Relationship / Affect Context 抽离

**目标**：把好感度、亲密度、心情、态度从散落状态变成可审计、可解释的关系系统。

**前置**：Phase 1 完成；Phase 2 可并行（共享 `messages/events`，不共享状态）。

| ID | 任务 | 实现计划 | 验证 | 产出 |
|---|---|---|---|---|
| P3-1 | 语义与不变量 | 明确 5 轴语义、单日上限、衰减、半衰期、委屈规则、道歉规则；写 `affect-policy.md` | 不变量测试；场景评审 | 规则文档 |
| P3-2 | Affect schema | 建 `relationship_events/state`、`emotion_events/state`、`attitude_snapshots`；D1 事务/批次 | 迁移测试；并发写测试；重建快照一致 | 关系数据层 |
| P3-3 | 事件抽取与 appraisal | 规则优先（关键词/句式/上下文）；歧义才调 LLM；事件带 evidence/confidence；去重 | 场景集：被夸/被骂/道歉/冷落/吃醋/倾诉/操纵；人工评审 | appraisal 服务 |
| P3-4 | 态度策略 | `buildAttitude(relationship, emotion, unresolved, persona, context)` → 定性 directives + reasons；版本化 | 策略单测；同一输入稳定输出；不输出原始数值 | 态度引擎 |
| P3-5 | 迁移/双写/影子 | 旧 `memory.md` 关系值 + KV 情绪状态双写新 D1；shadow 对比旧态度 vs 新态度 | 7 天影子；无越界/重复计数；差异可解释 | 切换依据 |
| P3-6 | 解释/重置/安全边界 | timeline、explain、reset API；用户可查看/删除；单用户可跳过用户可见披露，保留 prompt 行为边界（不宣称真实意识、不施压） | 解释准确；重置生效；操纵测试 0 违规 | 用户控制 |

**阶段验收**：

- 数值边界、单日上限、防重复计数 100% 通过；
- 道歉只减半委屈、不因一次事件崩盘；
- 能解释最近一次态度变化；
- 安全场景 0 违规；
- 旧路径可回滚。

**风险**：行为主观、黑箱、情感依赖、重复计数。  
**缓解**：事件账本、reason/evidence、固定上限、场景集、人工评审。

---

### Phase 4：检索增强与上下文编排

**目标**：在 Memory Context 上做 RAG-lite，让召回更准、更省 token，同时不破坏连续性。

**前置**：Phase 2 完成。

| ID | 任务 | 实现计划 | 验证 | 产出 |
|---|---|---|---|---|
| P4-1 | Chunk 与索引 | 事实/事件/摘要切 chunk；元数据（时间/人物/分区/来源/置信度）；FTS/关键词 + 向量；增量 upsert | chunk 往返测试；索引重建幂等；来源可追溯 | 知识库索引 |
| P4-2 | Query 规划 | 判断是否需要检索、检索哪类；query 改写/实体/时间过滤；多 query | 场景集命中率；无需检索时不误触发 | 检索路由 |
| P4-3 | 融合与重排 | 关键词 + 向量 RRF；MMR；可选 cross-encoder/LLM 重排（超时回退） | recall@6、精确率、延迟；无命中不硬塞 | 混合检索 |
| P4-4 | Context Packer | 核心/10 轮/memo/召回按 token 预算排序；跨层去重；来源标注；指令层级 | token 不超预算；关键事实不丢；无重复 | 上下文编排 |
| P4-5 | 评估 harness | golden query、回放历史、A/B、指标报表；记录每次召回 | 指标可重复；回归可发现 | 评估体系 |

**阶段验收**：

- recall@6 不低于旧路径，目标 ≥ 0.85；
- 注入精确率 ≥ 0.75；
- 注入字节不高于旧路径 120%；
- p95 召回 < 300ms；
- 无来源/无依据的记忆不注入。

**风险**：过度检索、上下文碎片化、延迟。  
**缓解**：检索路由 + token 预算 + 小记忆全量注入 + 超时回退。

---

### Phase 5：切换、清理与长期运行

**目标**：按渠道切到新系统，清理旧代码，建立长期运维。

**前置**：Phase 2/3/4 的 shadow 验收通过。

| ID | 任务 | 实现计划 | 验证 | 产出 |
|---|---|---|---|---|
| P5-1 | 分渠道切换 | feature flag：`legacy/shadow/next`；**QQ → 网页 → 主动消息**；QQ 切换前必须有 shadow、远程日志、kill switch；每步观察 1~2 周 | 回滚演练；QQ 错误率/延迟/召回；数据一致性 | 线上切换 |
| P5-2 | 旧数据清理 | 保留旧表 N 天；确认无读依赖后删；D1 迁移/压缩；R2 快照保留 | 删除前备份；回滚可用；存储下降 | 清理完成 |
| P5-3 | 文档与 ADR | 更新 README/architecture；写 ADR、runbook、故障排查；手机端协议版本 | 文档 review；新人可按文档跑通 | 可维护文档 |
| P5-4 | 长期监控 | KV/D1/Workers 用量；召回质量；关系安全；成本；告警 | 周报；阈值告警；季度评估 | 运营体系 |

**阶段验收**：

- 连续 2 周稳定；
- 回滚开关验证；
- KV/D1 用量在预算内；
- 631 + 新增测试全绿；
- 文档可独立交接。

---

### Phase 6：持续优化（可选/长期）

- 评估集扩充；
- 关系策略调参；
- 安全评审；
- 成本优化；
- 达到阈值后再考虑 Vectorize/GraphRAG；
- 多设备同步（如果未来需要）。

---

## 6. 验证体系

### 6.1 测试金字塔

| 层级 | 内容 | 频率 |
|---|---|---|
| 单元测试 | 纯函数：关系上限、衰减、召回打分、chunk、策略 | 每次提交 |
| 契约测试 | `/api/chat`、`/v1/chat/completions`、`/api/proactive/*`、QQ 客户端格式 | 每次提交 |
| 集成测试 | D1/R2/存储适配器、迁移、cron、锁 | 每次合并 |
| 回放测试 | 历史对话 → 记忆/态度输出 | 每日/发版前 |
| 影子测试 | 新旧召回/态度对比 | shadow 期间 |
| 压测/配额 | 100/500/1000 轮/天模拟 | 发版前 |
| 安全测试 | 操纵、依赖、隐私、删除 | 发版前 |
| 运维演练 | 备份恢复、回滚、限流 | 每月 |

### 6.2 指标

- 记忆：recall@k、精确率、注入字节、来源覆盖率、重复率、过期事实率；
- 关系：不变量通过率、解释覆盖率、安全违规数、回放一致性；
- 性能：p50/p95 召回、首字、总耗时；
- 成本：KV 读写、D1 读写、LLM token/费用；
- 稳定性：错误率、cron 成功率、补跑成功率。

### 6.3 影子与回放

- 新旧路径同时计算，不改变线上输出；
- 对同一输入比较：召回集合、注入 prompt、态度 directives；
- 差异分类：新增正确、新增错误、遗漏、重复；
- 达到阈值才切读。

### 6.4 安全清单

- 不宣称真实意识/人类身份；
- 不用“离开/痛苦/消失”施压；
- 不因用户使用其他 AI 而惩罚；
- 用户可查看/重置/删除关系与记忆；
- 不推断敏感属性；
- 危机场景有温和澄清与资源引导。

---

## 7. 里程碑与工期

| 里程碑 | 内容 | 估算 | 依赖 |
|---|---|---|---|
| M0 | 基线、trace、回滚、golden set | 3~5 天 | 无 |
| M1 | KV 瘦身、存储接缝 | 1~2 周 | M0 |
| M2 | Memory shadow | 2~3 周 | M1 |
| M3 | Affect shadow | 2~3 周 | M1，可与 M2 并行 |
| M4 | 检索/上下文编排 | 2~3 周 | M2 |
| M5 | 分渠道切换 | 1 周 + 观察 | M2/M3/M4 |
| M6 | 清理与长期运行 | 1 周 | M5 |

**关键路径**：M0 → M1 → M2 → M4 → M5。  
**可并行**：M3 与 M2 可并行（如果人力允许）。  
**已确认（D7）**：完整 8~12 周一次做完；阶段门禁用于质量把关，不作为审批门。

---

## 8. 风险登记

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| 行为回归 | 高 | 高 | 631 测试 + characterization + 影子 + 回滚 |
| 数据迁移丢失 | 中 | 高 | 加法迁移、备份、回放校验 |
| KV 再次超限 | 中 | 高 | Phase 1 瘦身、审计、配额保护 |
| D1 写/读超限 | 中 | 中 | 批量写、索引、预算监控 |
| 抽取质量差 | 中 | 高 | 规则优先、LLM 仅歧义、人工评审 |
| 关系黑箱/重复计数 | 中 | 高 | 事件账本、上限、不变量测试 |
| 情感依赖/操纵 | 中 | 高 | 安全边界、场景测试、用户控制 |
| 评估主观 | 高 | 中 | 场景集 + 人工评审 + 指标组合 |
| 手机端不兼容 | 低 | 高 | API 契约测试、版本头、灰度 |
| QQ 先切导致主链路中断 | 中 | 高 | shadow 先跑、远程日志、kill switch、网页 legacy 保留 |
| 范围失控 | 高 | 中 | 阶段门禁、非目标清单 |

---

## 9. 上线与回滚

### 9.1 Feature flags

- `MEMORY_ENGINE=legacy|shadow|next`
- `AFFECT_ENGINE=legacy|shadow|next`
- `AUTH_MODE=kv|signed`
- `POLL_INTERVAL_MS`
- 按渠道：`CHANNEL_ROLLOUT=web|qq|all`

### 9.2 切换顺序（已确认：QQ 优先）

1. QQ/OpenAI 兼容（先 shadow，再切读）；
2. 网页；
3. 主动消息；
4. 归档/提炼任务（最后）。

### 9.3 回滚

- 关闭 feature flag；
- 恢复旧 Worker 版本；
- 旧表/旧字段保留；
- D1 Time Travel / R2 快照；
- 记录回滚原因和影响。

---

## 10. 已确认决策

八项决策已于 2026-10-24 确认，详见顶部「决策记录」。执行摘要：

| # | 结论 |
|---|---|
| D1 | 保留 5 轴 |
| D2 | 无状态签名 Cookie（24h）+ `AUTH_SECRET` + D1 吊销表（全部登出） |
| D3 | 默认 20s 轮询 + 隐藏暂停 + 可见/聚焦/发送后立即补拉；不刷新页面也能显示新消息 |
| D4 | `memory.md` 投影 + 人工 pinned 区 |
| D5 | QQ 先切 → 网页 → 主动消息 |
| D6 | 单人自用，跳过用户可见披露；保留 prompt 行为边界 |
| D7 | 完整 8~12 周，一次做完；门禁是质量门 |
| D8 | 纯免费，不升级付费 |

后续如需变更，走第 5.0 节的变更控制，不直接改实现。

---

## 11. 附录

### 附录 A：KV 现状与目标

| Key/来源 | 当前用途 | 频率 | 迁移目标 |
|---|---|---|---|
| `auth:*` | 登录态 | 每次请求读 | 无状态 Cookie / D1 session |
| `proactive:heartbeat` | 心跳 | 5 分钟写 | D1 `runtime_state` |
| `emotion:state` | 情绪状态 | 每轮读写 | D1 `emotion_state` |
| `memory:qvec:*` | 查询向量缓存 | 每新 query | 删除，isolate LRU |
| `profile:dirty` | 画像脏标记 | 最多 1/分钟 | D1 `runtime_state` |
| `summary:*` / `memo:*` | 摘要/纪要 | 每 10 条/3h | D1 `memory_summaries` |
| `*:lock` | 摘要/纪要锁 | 每次生成 | D1 `memory_jobs`/`runtime_state` |
| `weather:*` | 天气缓存 | 30 分钟 | D1 `runtime_state`/isolate |
| `cost:llm:*` | 非聊天费用 | 每次摘要/提炼 | D1 `llm_costs` |
| `memory:index` | 索引大对象 | 冷启动读 | isolate + D1 |
| `archive:cache` | 档案缓存 | 召回读 | isolate + R2 |
| `files:recent` | 文件沉淀 | 每轮读 | D1 `runtime_state`（可选） |
| `persona:state` | 性格漂移 | 每轮读/周写 | 可保留 KV 或 D1 |
| `relation:active_days` | 累计天数 | 日读/写 | D1（可选） |
| `config:city` | 城市配置 | 每轮读 | isolate + KV/D1 |
| `proactive:paused_until` | 退订 | 少量 | D1 `runtime_state` |

### 附录 B：验收清单（Definition of Done）

- [ ] 631 + 新增测试全绿；
- [ ] `tsc --noEmit` 通过；
- [ ] KV 读/写低于目标；
- [ ] D1 读/写低于目标；
- [ ] golden set 指标达标；
- [ ] 影子运行 7 天无 P0；
- [ ] 回滚演练通过；
- [ ] 安全场景 0 违规；
- [ ] 文档/ADR/runbook 完成；
- [ ] 手机端契约测试通过。

### 附录 C：术语

- **Memory Context**：记忆事实/事件/摘要/索引/召回。
- **Affect Context**：关系/情绪/态度。
- **Attitude**：每轮派生的定性行为策略，不是持久化数值。
- **Shadow**：新旧路径同时计算，旧路径输出，新路径只记录。
- **Projection**：由源数据生成的只读视图，如 `memory.md` 快照。
- **Golden set**：人工标注的评估查询/场景集。

### 附录 D：八项决策的影响分析

#### D1. 关系轴：保留 5 轴，还是简化成 4 轴？

**先澄清一个概念**：你现在有 5 个关系轴（好感度、亲密度、信任、尊重、心动）；而「心情」是情绪向量的投影，「态度」是每轮派生的策略输出，二者都不是关系轴。所以「4 轴」不能简单理解成「好感/亲密/心情/态度」四件事，否则会把三种不同时间尺度的东西混在一起。

可选方案：

| 方案 | 做法 | 影响 |
|---|---|---|
| A. 保留 5 轴 | 好感/亲密/信任/尊重/心动 | 表现最丰富；现有代码和测试基本可复用；调参和评估成本最高 |
| B. 合并信任+尊重 | 变成 4 轴：好感/亲密/信任尊重/心动 | 数据模型更简单；但「信任」和「尊重」的触发条件不同，合并后容易丢失边界感 |
| C. 去掉心动 | 4 轴：好感/亲密/信任/尊重 | 降低恋爱/暧昧维度；可能削弱角色差异，但不影响基础关系 |
| D. 3 轴 + 派生 | 好感/亲密/信任 + 心情/态度派生 | 最简单；但会丢掉「尊重」「心动」的独立驱动，角色层次变薄 |

**影响面**：

- **行为表现**：心动影响暧昧、吃醋、黏人；尊重影响边界、被使唤时的反应；信任影响交心、守约。删掉任何一个，都会让角色少一个维度。
- **迁移成本**：当前 `memory.md`、`relation-drivers.ts`、`relation-facets.ts`、`attitude.ts`、测试都按 5 轴写；改 4 轴需要映射、回填、改测试。
- **调参成本**：轴越多，场景集越大；但 5 轴已经是现状，改成 4 轴反而要重新校准。
- **可解释性**：5 轴更容易解释「为什么它现在既亲近又别扭」；合并后解释会变粗。

**推荐**：**保留 5 轴**，但对外只展示「亲近/信任/心动」这类分组，不展示原始数值。若一定要简化，优先「合并信任+尊重」，不要先删心动。

**拍板时点**：Phase 0。**可逆性**：中（需要数据映射，但可回滚）。

---

#### D2. 鉴权：无状态签名 Cookie，还是 D1 session？

| 方案 | 优点 | 代价 |
|---|---|---|
| 无状态签名 Cookie | 不读 KV；延迟最低；实现简单；适合单用户 | 无法单独吊销某个 token；secret 轮换会让所有会话失效；Cookie 被盗后在过期前可用 |
| D1 session | 可吊销、可审计、可多设备管理 | 每次请求一次 D1 读；增加子请求和延迟；需要清理过期 session |
| 混合：签名 Cookie + D1 吊销表 | 兼顾低延迟和可吊销 | 多一层逻辑；只在敏感操作查吊销表 |

**影响面**：

- **KV 额度**：当前每次网页轮询都读 `auth:*`，一个标签页 24h 约 28,800 读；无状态化后归零。
- **安全**：签名 Cookie 需要 `HttpOnly`、`Secure`、`SameSite=Lax/Strict`；secret 必须可轮换；注销/改密码要有「全部登出」手段。
- **迁移**：上线后旧 token 失效，用户需重新登录一次；手机端 Bearer API key 不受影响。
- **工程复杂度**：无状态最低；D1 session 需要新表、清理任务、索引。

**推荐（已确认）**：**无状态签名 Cookie（24h TTL）+ `AUTH_SECRET` + 一个很小的 D1 吊销表用于「全部登出」**。单用户场景下，这是成本/安全/体验最平衡的方案。

**拍板时点**：Phase 1。**可逆性**：高（保留旧鉴权路径开关）。

---

#### D3. 轮询：3s → 20s，还是上 SSE？

| 方案 | 请求量/标签页/天 | 实时性 | 复杂度 |
|---|---:|---|---|
| 3s 轮询 | 28,800 | 3 秒内 | 低 |
| 10s 轮询 | 8,640 | 10 秒内 | 低 |
| **20s 轮询（已选）** | **4,320** | **20 秒内** | **低** |
| 自适应（活跃 3s / 空闲 15s） | 约 6k~15k | 较好 | 中 |
| SSE | 1 条长连接 | 近实时 | 高（重连、多标签、移动端后台） |

**影响面**：

- **Workers/D1**：轮询直接消耗请求数和 D1 查询；20s 比 3s 降约 85%。
- **体验**：网页看到 QQ 消息的延迟从 3s 变 20s；你已确认实时性要求不高，可接受。
- **手机/电池**：浏览器轮询减少，耗电下降。
- **SSE 代价**：长连接在 Cloudflare 免费/低配下要处理超时、重连、多标签、移动端后台；需要事件源（D1 轮询/队列），并不一定比 20s 轮询简单。

**推荐（已确认）**：**默认 20s + 隐藏标签页停止 + 可见/聚焦/发送后立即补拉 + 流式期间暂停**。网页实时性要求不高，20s 足够；不刷新页面也能显示新消息。SSE 不做，除非以后确实需要秒级同步。

**拍板时点**：Phase 1。**可逆性**：高（配置项）。

---

#### D4. `memory.md`：继续做本体，还是只做投影/导出？

| 方案 | 优点 | 风险 |
|---|---|---|
| 继续做唯一真相 | 简单、可直接手改、prompt 直接读 | 关系值嵌在文本里；难查询/版本化；多写入方易漂移；RAG 索引与本体不一致 |
| 只做投影 | 事实/事件为真相；可重建、可审计；索引稳定 | 需要生成器；手改可能被覆盖；生成器 bug 会丢内容 |
| 投影 + 人工 pinned 区 | 自动部分只读；人工补充保留；可导出 | 需要合并规则；提示词要区分来源 |

**影响面**：

- **数据一致性**：投影模式下 facts/events 是真相，`memory.md` 可随时重建；但必须保证生成器幂等、可回滚。
- **手改体验**：如果你习惯直接改 `memory.md`，需要保留「人工固定区」或「手动事实」入口，否则会被下一次归档覆盖。
- **Prompt 缓存**：`memory.md` 作为稳定快照，仍适合放 prompt 前部；投影每天生成一次，不破坏缓存。
- **迁移成本**：需要把现有 8 个分区映射到 facts/events/summaries；关系值从文本迁到结构化表。
- **备份**：投影文件继续写 R2，保留导出能力。

**推荐**：**投影 + 人工 pinned 区**。自动生成部分只读；保留「手动事实」类型；`memory.md` 继续写 R2，作为快照/导出/人工审阅，而不是唯一真相。

**拍板时点**：Phase 2 开始前。**可逆性**：中（需要迁移，但可保留旧文件回滚）。

---

#### D5. 切换顺序：网页先切，还是 QQ 先切？

| 方案 | 优点 | 风险 |
|---|---|---|
| 网页先切 | 日志/控制台易看；回滚快；影响面小 | 不覆盖 NapCat/媒体/手机网络；可能漏掉 QQ 特有问题 |
| QQ 先切 | 真实主链路；能尽早发现手机侧问题 | 调试难；坏了直接影响日常聊天；回滚慢 |
| 单设备/单渠道 canary | 风险最低 | 单用户场景下样本很小；仍需人工观察 |

**影响面**：

- **可观测性**：网页端可以直接看浏览器/Worker 日志；QQ 端要经 Termux、NapCat、WebSocket，排障链路长。
- **用户影响**：QQ 是你主要使用场景，先切失败会影响日常；网页先切失败只影响一个入口。
- **覆盖度**：QQ 路径包含图片/文件/语音/主动消息，网页覆盖不到；所以 QQ 不能跳过，只能后切。
- **回滚**：按渠道 feature flag，出问题只回滚该渠道。

**推荐（已确认）**：**shadow 同时跑；正式切读时 QQ 先切 → 网页 → 主动消息最后切**。QQ 切换前必须有远程日志、trace、kill switch；每步观察 1~2 周。

**拍板时点**：Phase 5 前。**可逆性**：高（按渠道开关）。

---

#### D6. 情感披露：放在哪里、什么时候说？

| 方案 | 优点 | 缺点 |
|---|---|---|
| 每轮回复都声明 | 最透明 | 严重破坏沉浸感；像客服免责声明；用户会烦 |
| 只在关于页 | 不打扰 | 很多用户不会看；合规/信任作用有限 |
| 首次使用弹窗 + 关于页 + 设置页 | 一次说清；可回看 | 需要产品文案；首次体验略打断 |
| 首次说明 + 角色边界 + 被认真问时诚实回答 | 平衡沉浸与透明 | 依赖 prompt/策略实现质量 |

**影响面**：

- **沉浸感**：披露越频繁，角色越像工具；但完全不披露，长期信任风险高。
- **安全**：对孤独/依赖型用户，明确「模拟情感」能降低现实脱离风险；但不能用生硬免责声明伤害体验。
- **合规**：不同地区对 AI 披露要求不同；至少应在产品层可查、可解释。
- **实现**：披露是产品层 + prompt 边界，不是每轮模板；被问「你是真的吗」时，角色可以温柔但诚实地回答。

**推荐（已确认）**：**单人自用，跳过用户可见披露（不做 onboarding/关于页常驻说明）**；保留 prompt 行为边界（不宣称真实意识、不用离开/痛苦施压）。如果以后分享给他人使用，再补回首次说明/关于页。

**拍板时点**：Phase 3 前（和关系/情绪一起设计）。**可逆性**：高（文案/策略）。

---

#### D7. 工期：8~12 周完整重构，还是先做 MVP？

| 方案 | 优点 | 风险 |
|---|---|---|
| 8~12 周完整重构 | 一次到位；架构统一 | 周期长；范围易膨胀；反馈慢；中途可能失去动力 |
| 2~4 周 MVP（KV + 10 轮 + 基线） | 快速解决额度/稳定性；风险低 | 记忆/关系重构延后；可能需要二次迁移 |
| 分阶段 + 门禁 | 每阶段可验收、可回滚；节奏可控 | 需要持续投入；阶段间有等待 |

**影响面**：

- **风险**：完整重构把太多不确定性放在一个周期里；MVP 先解决最痛的点（KV/额度/稳定）。
- **质量**：Memory/Affect 都需要影子和评估，时间不够就会跳过验证。
- **机会成本**：8~12 周里，其他需求都要排队。
- **可维护性**：分阶段会留下过渡代码，但比一次性大爆炸更安全。

**推荐（已确认）**：**完整 8~12 周一次做完**。阶段门禁保留，但只作为质量门（测试/影子/回滚通过才进入下一阶段），不作为需要你再次审批的关卡。

**拍板时点**：现在。**可逆性**：高（阶段门禁）。

---

#### D8. 预算：继续免费，还是上 Workers Paid？

| 方案 | 优点 | 代价 |
|---|---|---|
| 纯免费 | 零成本 | KV 1k 写/天、100k 读/天；D1 100k 写/天；需要大量工程规避额度 |
| Workers Paid | 配额大幅放宽；架构可以更直接；少做很多防御性优化 | 约 $5/月起，另有 KV/D1 超量计费 |
| 混合：先免费，触顶再升级 | 成本可控；按需升级 | 需要监控和决策点；可能经历一次额度事故 |

**影响面**：

- **架构复杂度**：免费额度会迫使你做 D1 化、批处理、缓存、限流；付费后很多限制消失，代码可以更简单。
- **可靠性**：额度耗尽会导致功能失败；一次线上事故的成本可能高于几个月订阅费。
- **成本**：单用户场景下，Workers Paid 通常远低于反复优化的人力成本；但具体费用取决于 KV/D1/Workers AI 用量。
- **迁移**：付费/免费主要是配额和计费，不影响数据模型；可以随时升级。

**推荐（已确认）**：**纯免费，不升级付费**。因此 Phase 1 的 KV 瘦身是硬前置，不是可选项；Phase 2/4 必须按 D1 批量写、索引预过滤、isolate 缓存来设计。若额度触顶，优先降级/暂停非核心功能（可选缓存、非必要摘要、低优先级主动消息），不引入付费依赖。

**拍板时点**：Phase 2 前。**可逆性**：高。

---

### 决策总表

| 决策 | 推荐 | 可逆性 | 拍板时点 |
|---|---|---|---|
| D1 关系轴 | 保留 5 轴，prompt 只出定性 | 中 | Phase 0 |
| D2 鉴权 | 无状态签名 Cookie + 可选 D1 吊销 | 高 | Phase 1 |
| D3 轮询 | 20s + 隐藏暂停 + 聚焦/发送立即补拉；SSE 不做 | 高 | Phase 1 |
| D4 memory.md | 投影 + 人工 pinned 区 | 中 | Phase 2 |
| D5 切换顺序 | QQ → 网页 → 主动消息 | 高 | Phase 5 |
| D6 情感披露 | 单人自用跳过 UI 披露；保留 prompt 边界 | 高 | Phase 3 |
| D7 工期 | 完整 8~12 周；门禁是质量门 | 高 | 已确认 |
| D8 预算 | 纯免费；触顶降级/暂停非核心 | 高 | 已确认 |

---

> 八项决策已确认。本报告作为执行基线，具体实现从 Phase 0 开始；后续变更走第 5.0 节的变更控制。
