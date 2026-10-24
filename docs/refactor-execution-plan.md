# 记忆与关系系统重构 · Phase 0–5 执行计划

> 关联文档：[refactor-master-plan.md](./refactor-master-plan.md)  
> 版本：v0.1（执行版）  
> 日期：2026-10-24  
> 范围：Phase 0–5；Phase 6 单独排期，不在本计划内  
> 原则：一次只推进一个 Phase；每个 Phase 通过门禁后再进入下一阶段

---

## 0. 执行状态

| Phase | 状态 | 报告/证据 | 提交/tag |
|---|---|---|---|
| 0 | ✅ 完成（tagged） | `docs/phase-0-report.md` | `refactor-p0` |
| 1 | ✅ 完成（tagged） | `docs/phase-1-report.md` | `refactor-p1` |
| 2 | ✅ 完成（工程门禁；7 天生产影子在 Phase 5 上线前） | `docs/phase-2-progress.md` | `refactor-p2` |
| 3 | ⏳ 待开始 | - | `refactor-p3` |
| 4 | ⏳ 待开始 | - | `refactor-p4` |
| 5 | ⏳ 待开始 | - | `refactor-p5` |

---

## 1. 执行目标

把 master plan 中的阶段拆成可执行、可验收、可提交的工作包：

- 每个工作包有明确的输入、步骤、产出、验证；
- 每个 Phase 有质量门禁（测试、指标、回滚）；
- 每个 Phase 结束做一个可回滚的 git 提交/tag；
- 不在 Phase 5 之前切换线上读路径；
- Phase 6（表现层调优）严格留到最后，不混入本轮工程重构。

---

## 2. 执行规则

1. **一个 Phase 一个主题**：不跨阶段混改；紧急修复单独提交。
2. **先测试后实现**：涉及行为变化的任务，先补 characterization/contract test。
3. **加法迁移**：先加表/列/双写，不先删旧。
4. **feature flag**：新路径默认 `shadow`，不默认 `next`。
5. **每个 Phase 结束提交**：提交信息格式 `refactor(pN): <summary>`；打 tag `refactor-pN`。
6. **门禁不通过不进入下一阶段**：测试/指标/回滚任一失败，先修复。
7. **每阶段更新文档**：当前状态、迁移说明、runbook、未决风险。
8. **生产部署只在 Phase 5 门禁通过后**；Phase 0–4 只本地/预发验证。
9. **不提交密钥**：`.dev.vars`、`wrangler.local.toml`、真实 memory/chat logs 不进 git。
10. **Phase 6 隔离**：本文档不包含语气/主动性/表现层调参任务。

---

## 3. 阶段总览

| Phase | 目标 | 核心产出 | 门禁 |
|---|---|---|---|
| 0 | 基线与安全网 | 现状清单、基线测试、trace、回滚 runbook、golden set | 测试全绿、trace 可用、可回滚、评估集可读 |
| 1 | 存储接缝与 KV 瘦身 | 存储端口、D1 runtime_state、无状态鉴权、轮询优化、KV 审计 | KV 读/写达标、行为不变、回滚开关可用 |
| 2 | Memory Context | facts/events/summaries/chunks、投影、影子召回 | shadow 不劣于旧路径、无数据丢失、token 不超标 |
| 3 | Affect Context | 关系/情绪账本、态度策略、解释/重置 | 不变量 100%、场景集通过、安全 0 违规 |
| 4 | 检索与上下文 | 混合检索、RRF、query 规划、context packer | recall/precision/延迟/token 达标 |
| 5 | 切换与清理 | QQ→网页→主动消息切换、旧代码清理、监控 | 连续 2 周稳定、回滚演练通过 |

---

## 4. Phase 0：基线与安全网

### 目标

在不改变行为的前提下，建立“可测试、可观测、可回滚、可评估”的基线。

### 任务包

#### P0-A 现状清单

**输入**：当前 `src/`、`public/`、`schema.sql`、`wrangler.toml`、`docs/`。  
**步骤**：

1. 列出所有 HTTP 路由（web/openai/admin/queue）；
2. 列出所有 cron 与触发时间；
3. 列出所有 D1 表/索引；
4. 列出所有 R2 key 前缀；
5. 列出所有 KV key、读写频率、TTL；
6. 标出 legacy / 待替换 / 保留；
7. 记录当前测试数、构建命令、Node/Python 版本。

**产出**：`docs/current-state.md`。  
**验证**：清单覆盖 `grep env.KV/env.DB/env.R2` 的全部调用点；人工 review 无遗漏。

#### P0-B 基线与测试

**输入**：现有 631 个 Worker 测试。  
**步骤**：

1. 跑 `tsc --noEmit` 与 `vitest run`，记录结果；
2. 新增 `scripts/verify.sh`（tsc + vitest + 可选 build）；
3. 补关键 characterization tests：
   - 10 轮历史顺序与时间戳；
   - 归档失败/补跑；
   - KV 鉴权读取路径（当前行为）；
   - 关系/情绪不变量（边界、日上限、道歉）；
4. 记录基线指标：测试数、耗时、召回 golden 基线、KV 估算。

**产出**：`docs/baseline.md`、`scripts/verify.sh`、新增测试。  
**验证**：`bash scripts/verify.sh` 全绿；连续跑两次结果一致。

#### P0-C Trace 与 request-id

**输入**：Hono 路由、chat/openai 入口。  
**步骤**：

1. 新增 `src/trace.ts`：生成/读取 `X-Request-Id`，结构化日志 helper；
2. 在 `index.ts` 加全局 middleware：注入 request-id、记录 method/path/status/ms；
3. 在 `/api/chat` 与 `/v1/chat/completions` 记录：
   - channel；
   - memory mode/bytes；
   - history rounds；
   - recall lines；
   - 关键耗时；
4. 错误日志带 request-id；
5. 不记录完整用户内容，避免日志泄漏。

**产出**：`src/trace.ts`、middleware、memory context log。  
**验证**：一次网页聊天/QQ 聊天能在日志里用 request-id 串起来；无敏感内容；631 测试通过。

#### P0-D 备份与回滚 runbook

**输入**：D1/R2/Worker 部署方式。  
**步骤**：

1. 写 `docs/runbooks/backup-rollback.md`：
   - D1 export / Time Travel；
   - R2 `memory.md`、`chat_logs/` 备份；
   - 上一版 Worker 部署与 rollback；
   - feature flag 回滚；
2. 做一次只读演练：导出 D1 schema/计数，读取 R2 memory.md；
3. 记录 RTO/RPO 与操作人步骤；
4. 明确哪些操作不能在生产直接执行。

**产出**：runbook、演练记录。  
**验证**：按文档可以从零执行一次备份/读取；回滚步骤无歧义。

#### P0-E Golden set 与场景集

**输入**：当前 memory/affect 行为、历史对话样本。  
**步骤**：

1. 建 `docs/eval/golden-memory.json`：20~50 条 query + 期望记忆要点；
2. 建 `docs/eval/affect-scenarios.json`：被夸/被骂/道歉/冷落/吃醋/倾诉/操纵等；
3. 建 `docs/eval/safety-cases.json`：依赖诱导、意识宣称、离开施压；
4. 写 `docs/eval/README.md`：字段说明、评分方式、如何回放；
5. 记录基线（人工或脚本），作为 Phase 2/3/4 对比。

**产出**：评估集 v1。  
**验证**：评审集可读、无歧义；基线分数记录；后续阶段可直接复用。

### 执行顺序

`P0-A → P0-B → P0-C → P0-D → P0-E`

### 门禁

- `tsc` + 631 测试 + 新增测试全绿；
- 一次网页/QQ 请求有 request-id 与 trace 日志；
- 备份/回滚 runbook 演练通过；
- golden set 可读、基线已记录；
- 提交 `refactor(p0): baseline and observability` + tag `refactor-p0`。

### 风险

- 补测试范围失控：只补关键路径；
- trace 记录敏感内容：只记录元信息，不记录正文；
- 备份占用空间：只备份必要对象，D1 export 压缩。

---

## 5. Phase 1：存储接缝与 KV 瘦身

### 目标

不改记忆/关系行为，把高频状态迁出 KV，降低额度风险。

### 任务包

#### P1-A 存储端口抽象

**步骤**：

1. 定义 `MessageStore`、`RawStore`、`CacheStore`、`LockStore`、`CostStore` 接口；
2. 先包装现有 D1/R2/KV 实现，不改变行为；
3. 把 `env.KV` 直接调用逐步收口到端口；
4. 保留旧路径 feature flag。

**验证**：端口单测；旧调用点清单归零；631 测试通过。

#### P1-B D1 runtime_state

**步骤**：

1. 建 `runtime_state(key, value, updated_at, expires_at)`；
2. 迁移 heartbeat、paused_until、offline_alert、profile_dirty、weather、locks；
3. 写清理任务（过期行）；
4. 对照旧 KV 行为测试。

**验证**：读写不再走 KV；24h soak；过期清理正确。

#### P1-C 无状态鉴权

**步骤**：

1. 定义 `auth_token = payload.signature`；
2. `AUTH_SECRET` 配置；
3. 登录签发 24h token；logout 清 Cookie；
4. `auth_revocations` D1 表支持「全部登出」；
5. 保留 `AUTH_MODE=kv|signed` 回滚开关。

**验证**：伪造/过期/登出/全部登出测试；`/api/history/since` 不再读 KV。

#### P1-D 轮询优化

**步骤**：

1. `POLL_INTERVAL_MS=20000`；
2. 隐藏标签页停止；
3. `visibilitychange`/focus/发送后立即补拉；
4. 流式期间暂停；
5. 不刷新页面显示新消息。

**验证**：24h 请求计数；跨渠道消息 20s 内出现；无重复渲染。

#### P1-E 清理低价值 KV

**步骤**：

1. 删除 `memory:qvec:*` KV，保留 isolate LRU；
2. `archive:cache` 改 isolate/R2；
3. `memory:index` 改 isolate + D1 回源；
4. 观察冷启动召回与延迟。

**验证**：KV 读写统计下降；召回正确；延迟不退化。

#### P1-F KV 审计与配额保护

**步骤**：

1. `/api/admin/kv-audit` 统计 key/读写；
2. 接近阈值时自动关闭可选缓存；
3. 告警/日志；
4. 文档记录降级策略。

**验证**：模拟超限；降级路径可用；告警可见。

### 门禁

- KV 读 < 5,000/天、写 < 100/天（按实际流量校准）；
- D1 写 < 50,000/天；
- 631 + 新增测试全绿；
- 登录/聊天/主动消息/归档行为不变；
- 回滚开关验证；
- 提交 `refactor(p1): storage seams and kv diet` + tag `refactor-p1`。

---

## 6. Phase 2：Memory Context 抽离

### 目标

把记忆从 Worker 各模块抽成独立上下文；建立 facts/events/summaries/chunks 分层。

### 任务包

#### P2-A 领域模型

**步骤**：

1. 定义 `MemoryFact / MemoryEvent / MemorySummary / MemoryChunk / Provenance / Validity`；
2. 纯函数：校验、序列化、去重、冲突、有效期；
3. 不依赖 Cloudflare API。

**验证**：单测覆盖不变量；类型检查。

#### P2-B D1 记忆 schema

**步骤**：

1. 新增表与索引；
2. 加法迁移；
3. 保留旧 `memory_entries`；
4. 回填脚本（可重复、可校验）。

**验证**：迁移重复执行安全；回填计数一致；旧路径仍可读。

#### P2-C 写入/提炼管线

**步骤**：

1. `ArchiveDay` 提取 facts/events；
2. 去重/冲突/有效期；
3. `memory_jobs` 异步任务、幂等键、重试；
4. 失败可观测。

**验证**：回放 7 天；重复任务不重复写；失败可重试。

#### P2-D 读取/召回管线

**步骤**：

1. `RecallMemory` 接口；
2. query 改写/过滤；
3. 关键词 + 向量 → RRF → MMR → 重排；
4. 返回 provenance；
5. token 预算。

**验证**：golden recall/precision；无命中返回空；延迟达标。

#### P2-E `memory.md` 投影

**步骤**：

1. 从 facts/events/summaries 生成 `memory.md`；
2. 保留人工 pinned 区；
3. 写 R2 前校验；
4. 备份旧文件。

**验证**：投影与源数据一致；手改 pinned 不丢；回滚可恢复。

#### P2-F 双写与影子

**步骤**：

1. 旧路径继续写 `memory.md`；
2. 新路径写 D1；
3. shadow 计算新召回；
4. 记录差异；
5. feature flag `MEMORY_ENGINE`。

**验证**：7 天影子；新旧召回差异报告；无 P0 回归。

### 门禁

- shadow 召回不低于旧路径；
- 无重复/过期事实进入 prompt；
- token 不高于旧路径 120%；
- 召回 p95 < 300ms；
- 提交 `refactor(p2): memory context` + tag `refactor-p2`。

---

## 7. Phase 3：Relationship / Affect Context 抽离

### 目标

把 5 轴关系、情绪、态度拆成可审计、可解释、可重置的独立上下文。

### 任务包

#### P3-A 语义与不变量

**步骤**：

1. 写 `docs/affect-policy.md`：5 轴、上限、衰减、半衰期、委屈/道歉；
2. 明确“心情派生、态度策略”；
3. 场景集评审。

**验证**：不变量测试；规则文档 review。

#### P3-B Affect schema

**步骤**：

1. `relationship_events/state`；
2. `emotion_events/state`；
3. `attitude_snapshots`；
4. D1 事务/批次；
5. 快照重建。

**验证**：迁移；并发写；重建一致。

#### P3-C 事件抽取与 appraisal

**步骤**：

1. 规则优先；
2. 歧义才 LLM；
3. evidence/confidence；
4. 去重/防重复计数。

**验证**：场景集；人工评审；不变量。

#### P3-D 态度策略

**步骤**：

1. `buildAttitude(...)`；
2. 定性 directives + reasons；
3. policy_version；
4. 不输出原始数值。

**验证**：稳定输出；场景评审；安全测试。

#### P3-E 迁移/双写/影子

**步骤**：

1. 旧 `memory.md` 关系值 + KV 情绪双写 D1；
2. shadow 对比旧/新态度；
3. 差异分类。

**验证**：7 天影子；无越界/重复；差异可解释。

#### P3-F 解释/重置/安全

**步骤**：

1. timeline/explain/reset API；
2. 用户可查看/删除；
3. prompt 行为边界；
4. 安全话术测试。

**验证**：解释准确；重置生效；操纵 0 违规。

### 门禁

- 数值边界/日上限/防重复 100%；
- 解释覆盖率 100%；
- 安全场景 0 违规；
- 提交 `refactor(p3): affect context` + tag `refactor-p3`。

---

## 8. Phase 4：检索增强与上下文编排

### 目标

在 Memory Context 上做 RAG-lite，提升召回质量与 token 效率。

### 任务包

#### P4-A Chunk 与索引

**步骤**：

1. facts/events/summaries 切 chunk；
2. 元数据（时间/人物/分区/来源/confidence）；
3. 关键词/FTS + 向量；
4. 增量 upsert。

**验证**：chunk 往返；索引重建幂等；来源可追溯。

#### P4-B Query 规划

**步骤**：

1. 判断是否需要检索；
2. query 改写/实体/时间过滤；
3. 多 query；
4. 检索路由。

**验证**：场景命中率；无需检索不误触发。

#### P4-C 融合与重排

**步骤**：

1. 关键词 + 向量 RRF；
2. MMR；
3. 可选 LLM 重排 + 超时回退；
4. 无命中不硬塞。

**验证**：recall@6、精确率、延迟。

#### P4-D Context Packer

**步骤**：

1. 核心/10 轮/memo/召回按预算排序；
2. 跨层去重；
3. 来源标注；
4. 指令层级。

**验证**：token 不超预算；关键事实不丢；无重复。

#### P4-E 评估 harness

**步骤**：

1. golden query 回放；
2. 历史对话回放；
3. A/B；
4. 指标报表。

**验证**：指标可重复；回归可发现。

### 门禁

- recall@6 ≥ 0.85 或不低于旧路径；
- 精确率 ≥ 0.75；
- 注入字节 ≤ 旧路径 120%；
- p95 召回 < 300ms；
- 提交 `refactor(p4): retrieval and context packing` + tag `refactor-p4`。

---

## 9. Phase 5：切换、清理与长期运行

### 目标

按已确认顺序 QQ → 网页 → 主动消息切换，清理旧路径，建立长期运行。

### 任务包

#### P5-A QQ shadow/远程日志

**步骤**：

1. QQ 路径 shadow；
2. 远程 trace/日志可查；
3. kill switch；
4. 手机端契约测试。

**验证**：QQ shadow 7 天；无 P0；可一键回滚。

#### P5-B 分渠道切换

**步骤**：

1. QQ 切读；
2. 网页切读；
3. 主动消息切；
4. 每步观察 1~2 周。

**验证**：错误率/延迟/召回/用户反馈；回滚演练。

#### P5-C 旧数据/旧代码清理

**步骤**：

1. 保留旧表 N 天；
2. 确认无读依赖后删；
3. D1 压缩/迁移；
4. R2 快照保留；
5. 删除死代码。

**验证**：删除前备份；回滚可用；存储下降。

#### P5-D 文档与长期监控

**步骤**：

1. 更新 README/architecture；
2. ADR/runbook/故障排查；
3. 手机端协议版本；
4. KV/D1/Workers 用量告警；
5. 召回/关系/安全周报。

**验证**：文档可交接；告警可用；2 周稳定。

### 门禁

- 连续 2 周稳定；
- 回滚开关验证；
- KV/D1 用量在预算内；
- 631 + 新增测试全绿；
- 提交 `refactor(p5): cutover and cleanup` + tag `refactor-p5`。

---

## 10. 每阶段交付物清单

| 阶段 | 代码 | 文档 | 验证 |
|---|---|---|---|
| P0 | trace、verify 脚本、测试 | current-state、baseline、runbook、eval | 全绿 + trace + 回滚演练 |
| P1 | ports、runtime_state、auth、polling、audit | 迁移说明、回滚说明 | KV/D1 指标 + 行为不变 |
| P2 | facts/events/summaries/chunks、投影、shadow | 记忆模型、迁移、投影规则 | shadow 报告 |
| P3 | 关系/情绪账本、态度策略、explain/reset | affect-policy、场景集 | 不变量 + 安全 + 人工评审 |
| P4 | 混合检索、RRF、packer、eval harness | 检索设计、指标说明 | recall/precision/延迟 |
| P5 | 切换、清理、监控 | runbook、ADR、README | 2 周稳定 + 回滚 |

---

## 11. Phase 6 边界

Phase 6 单独做，不混入 0–5：

- 语气/口癖/动作描写调优；
- 主动性/频率/时机调优；
- “像真人/生命感/活力”的人工评审与 A/B；
- 模型选择与 prompt 迭代；
- 安全与依赖风险的长期观察。

Phase 0–5 只保证：**记得对、存得住、关系稳、可解释、可回滚、成本可控**。  
Phase 6 才回答：**像不像人、有没有生命感、够不够有活力**。
