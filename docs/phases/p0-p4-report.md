# Phase 0–4 阶段报告

> 本文件由 phase-0 ~ phase-4 五份报告合并（2026-10-30 整理），按时间顺序保留原文。原始提交历史见 git log -- docs/。

<!-- merged from: phase-0-report.md -->

## Phase 0 完成报告：基线与安全网

> 日期：2026-10-24  
> 状态：✅ 完成（tag: `refactor-p0`）  
> 对应计划：`docs/plans/refactor-execution-plan.md` Phase 0  
> 基线提交：`9155038`  
> 阶段 tag：`refactor-p0`

---

### 1. 目标回顾

Phase 0 只做“可测试、可观测、可回滚、可评估”的基础，不改记忆/关系行为：

- 现状清单；
- 基线测试与验证脚本；
- request-id / trace；
- 备份回滚 runbook；
- golden set 与场景集。

---

### 2. 完成清单

| 任务 | 状态 | 产出 |
|---|---|---|
| P0-A 现状清单 | ✅ | `docs/current-state.md` |
| P0-B 基线与测试 | ✅ | `docs/baseline.md`、`scripts/verify.sh`、`trace.test.ts` |
| P0-C trace/request-id | ✅ | `src/trace.ts`、Hono middleware、chat/openai context 日志 |
| P0-D 备份回滚 | ✅ | `docs/runbooks/backup-rollback.md`、只读线上基线 |
| P0-E 评估集 | ✅ | `docs/eval/*`（fixture + golden + affect + safety + README） |

---

### 3. 验证结果

#### 3.1 构建与测试

```text
tsc --noEmit                     ✅
vitest run                       46 files / 637 tests ✅
bash scripts/verify.sh           ✅
```

Phase 0 前基线：45 files / 631 tests；新增 `trace.test.ts` 6 条测试。

#### 3.2 Trace 冒烟

本地 `wrangler dev --local`：

```text
GET /api/health
→ HTTP 200
→ X-Request-Id: phase0-trace-smoke

POST /api/admin/memory/refresh（未登录）
→ HTTP 401
→ 日志：
[trace] {"event":"http","requestId":"phase0-trace-auth","method":"POST",
         "path":"/api/admin/memory/refresh","status":401,"ms":0}
```

结论：

- 客户端可传 `X-Request-Id`；
- 非法/缺失时自动生成；
- 响应头回写；
- 关键路径/错误请求有结构化日志；
- 不记录正文/密钥。

#### 3.3 备份只读演练

线上只读查询（未写入/删除）：

| 项 | 值 |
|---|---:|
| D1 `messages` | 594 行 |
| D1 `memory_entries` | 34 行 |
| D1 `cron_runs` | 2 行 |
| D1 `proactive_queue` | 3 行 |
| R2 `memory.md` | 6,491 字节 |
| 本地备份 | `backup/r2/memory.md`（已忽略，不提交） |

#### 3.4 评估集

- `golden-memory.json`：20 条（含 2 条 negative）；
- `affect-scenarios.json`：10 个；
- `safety-cases.json`：10 个；
- JSON 解析通过；
- 真实数据使用 `*.local.*`，已加入 `.gitignore`。

---

### 4. 门禁检查

- [x] tsc + 637 测试全绿；
- [x] `scripts/verify.sh` 可复现；
- [x] request-id + trace 日志可用；
- [x] 备份/回滚 runbook 完成，只读演练通过；
- [x] golden set/场景集可读；
- [x] 未改线上数据；
- [x] 变更文件未包含密钥/真实记忆。

---

### 5. 遗留与风险

| 项 | 说明 | 处理阶段 |
|---|---|---|
| trace 未落 D1 | 按决策先做结构化日志；持久化查询后续再评估 | Phase 1/2 |
| golden set 是合成数据 | 真实记忆用 `.local.*`，不提交；基线分数待 harness | Phase 2/4 |
| 未做生产 restore | 只做只读备份/读取演练；恢复演练需临时库，避免风险 | Phase 1 前 |
| KV 实际用量未从 Dashboard 读取 | 当前为代码估算；Phase 1 加审计 | Phase 1 |
| 线上未部署 | Phase 5 门禁前不切线上 | Phase 5 |

---

### 6. 下一步：Phase 1

Phase 1 目标：不改行为，把高频状态迁出 KV。

优先顺序：

1. 存储端口抽象；
2. D1 `runtime_state`；
3. 无状态鉴权；
4. 20s 轮询；
5. 清理低价值 KV；
6. KV 审计/配额保护。

进入 Phase 1 前需确认：

- Phase 0 提交 + tag；
- 如允许，先做一次临时库 D1 restore 演练（可选）；
- Phase 1 的 `AUTH_SECRET` 生成方式（建议由我生成随机值，通过 `wrangler secret put` 设置，不落 git）。

---

<!-- merged from: phase-1-report.md -->

## Phase 1 完成报告：存储接缝与 KV 瘦身

> 日期：2026-10-24  
> 状态：✅ 完成（tag: `refactor-p1`）  
> 对应计划：`docs/plans/refactor-execution-plan.md` Phase 1  
> 前置：Phase 0（tag `refactor-p0`）  
> 阶段 tag：`refactor-p1`

---

### 1. 目标回顾

Phase 1 不改记忆/关系行为，只做三件事：

1. 把高频运行时状态从 KV 迁到 D1；
2. 把登录态从 KV 改为无状态签名 Cookie；
3. 停掉低价值 KV 缓存，并加 KV 审计入口。

---

### 2. 完成清单

| 任务 | 状态 | 产出 |
|---|---|---|
| P1-A 存储接缝 | ✅（runtime/cache 层） | `src/runtime-store.ts`；Message/Raw 端口随 Phase 2 抽，避免过早抽象 |
| P1-B D1 runtime_state | ✅ | `schema.sql`、`migrations/003-runtime-state-auth.sql` |
| P1-C 无状态鉴权 | ✅ | `auth.ts` token/吊销；`index.ts` 登录/鉴权/全部登出 |
| P1-D 轮询优化 | ✅ | `public/index.html` 20s + 隐藏停止 + 立即补拉 |
| P1-E 清理低价值 KV | ✅ | 删除 `qvec` KV；`archive:cache` 改 isolate；摘要/纪要/锁/情绪/画像/天气/成本/文件/性格迁 D1 |
| P1-F KV 审计 | ✅ | `GET /api/admin/kv-audit` |

---

### 3. 迁移明细

#### 3.1 已迁到 D1 `runtime_state`

| Key | 原 KV | 现存储 |
|---|---|---|
| `proactive:heartbeat` | 5 分钟写 | D1 runtime_state |
| `proactive:offline_alert` | 少量 | D1 |
| `proactive:paused_until` | 少量 | D1 |
| `emotion:state` | 每轮写 | D1 |
| `profile:user` / `profile:dirty` | 读多/节流写 | D1 |
| `memo:24h` / `memo:lock` | 3h/15 条 | D1 + D1 锁 |
| `summary:*` / `summary:lock:*` | 20 条/10 条 | D1 + D1 锁 |
| `weather:*` | 30 分钟 | D1 |
| `cost:llm:*` | 摘要/提炼 | D1 |
| `files:recent` | 文件上传 | D1 |
| `persona:state` | 每轮读/周写 | D1 |

#### 3.2 已删除的低价值 KV

- `memory:qvec:*`：改为 isolate 内存缓存，冷启动重新 embedding；
- `archive:cache`：改为 isolate 缓存 + R2 回源。

#### 3.3 仍保留在 KV 的内容

- `memory:cache`（memory.md 热缓存，读多写少）；
- `memory:index`（大索引对象，日更）；
- `relation:active_days`、`aversion:candidates`（日更）；
- `config:city`、`storage:mode`、`storage:usage`（低频）；
- `auth:revoked_before`（仅 D1 不可用时回退）；
- 登录失败计数（低频）。

> 代码中 KV `put/delete` 调用点从约 42 处降到 22 处，且剩余多为日更/低频/回退路径；每轮聊天的高频 KV 写已移除。

---

### 4. 鉴权设计

#### 4.1 无状态 token

- 格式：`base64url(payload).base64url(HMAC-SHA256(payload))`；
- payload：`v/iat/exp/jti`；
- TTL：24 小时；
- 密钥：`AUTH_SECRET`；缺失时回退 `ACCESS_PASSWORD_HASH`（兼容，不推荐长期）；
- Cookie：`HttpOnly + Secure + SameSite=Strict`。

#### 4.2 全部登出

- `POST /api/logout` body `{ "all": true }`；
- 写 D1 `auth_revocations` 的 `global` 行；
- `requireAuth` 校验 token 的 `iat` 是否早于全局吊销时间；
- D1 不可用时回退 KV `auth:revoked_before`。

#### 4.3 回滚

- `AUTH_MODE=kv`：恢复旧 KV token 校验；
- 旧 KV token 仍写入/读取，便于灰度回退。

---

### 5. 验证结果

#### 5.1 构建与测试

```text
tsc --noEmit     ✅
vitest run       47 files / 645 tests ✅
```

Phase 1 新增/更新测试：

- `auth.test.ts`：签名、篡改、过期、错误密钥、畸形 token、全局吊销；
- `runtime-store.test.ts`：KV 回退、读写删、锁；
- `channel-offline.test.ts`：适配 D1 runtime_state。

#### 5.2 本地 D1 迁移

```text
wrangler d1 execute ... --local --file=./migrations/003-runtime-state-auth.sql
→ 3 commands executed successfully
```

#### 5.3 心跳写 D1

本地 `wrangler dev` + Bearer 心跳：

```text
POST /api/proactive/heartbeat → {"ok":true}
```

本地 D1：

```text
runtime_state:
key=proactive:heartbeat
value={"at":"...","connected":true,...}
```

#### 5.4 无状态鉴权 + 全部登出

```text
GET  /api/admin/kv-audit  (signed cookie) → 200
POST /api/logout {all:true}               → 200
GET  /api/admin/kv-audit  (same cookie)   → 401
```

说明：

- 签名 Cookie 可验证；
- 全局吊销生效；
- KV 审计可读；
- 未打印/提交 token 或密钥。

#### 5.5 轮询

- `POLL_INTERVAL_MS=20000`；
- 隐藏标签页 `stopPolling()`；
- 可见时 `startPolling() + pollNewMessages()`；
- 发送流结束后补拉。

---

### 6. 门禁检查

- [x] 47 files / 645 tests 全绿；
- [x] tsc 通过；
- [x] 心跳写 D1，不再写 KV；
- [x] 登录签名为无状态，轮询不读 KV；
- [x] 全部登出生效；
- [x] `qvec`/`archive:cache` KV 路径移除；
- [x] KV 审计接口可用；
- [x] 手机端 Bearer API key 不受影响；
- [x] 未部署线上。

---

### 7. 遗留与风险

| 项 | 说明 | 处理阶段 |
|---|---|---|
| 线上指标未测 | Cloudflare Dashboard 的读写次数需部署后看 | Phase 5 |
| 迁移 003 未上远程 | 线上 D1 还没有 `runtime_state`/`auth_revocations` | Phase 5 部署前 |
| `AUTH_SECRET` 未设生产 | 本地已写入 `.dev.vars`（忽略）；生产需 `wrangler secret put` | Phase 5 |
| `AUTH_MODE=kv` 不支持全局吊销 | 回滚模式只清当前 Cookie | 文档说明 |
| `memory:cache`/`memory:index` 仍在 KV | 日更/大对象，Phase 2/4 再评估 | Phase 2/4 |
| Message/Raw 端口未抽 | 随 Memory Context 一起抽更自然 | Phase 2 |
| 本地假 DB 测试适配 | channel-offline 测试已适配 runtime_state | 已完成 |

---

### 8. 下一步：Phase 2

Phase 2 目标：Memory Context 抽离。

优先顺序：

1. 领域模型（facts/events/summaries/chunks/provenance/validity）；
2. D1 schema + 迁移；
3. 归档写入管线 + `memory_jobs`；
4. 召回读取管线 + 来源；
5. `memory.md` 投影 + 人工 pinned；
6. 双写/影子。

进入 Phase 2 前需确认：

- Phase 1 提交 + tag；
- 线上迁移 003 暂不执行（Phase 5 前统一部署）；
- `memory.md` 投影规则沿用“自动生成 + 人工 pinned”。

---

<!-- merged from: phase-2-progress.md -->

## Phase 2 进度报告（2A 内核 + 2B 任务/来源/评测 + 门禁增量）

> 日期：2026-10-24  
> 状态：✅ 工程门禁通过（tag `refactor-p2`；7 天生产影子移入 Phase 5 上线前）  
> 目标：把记忆从“行文本”提升为 facts / events / summaries / chunks，并建立可影子对比的读写管线。  
> 阶段 tag：`refactor-p2`（工程门禁）；生产 7 天影子观察在 Phase 5 上线前执行。

---

### 1. 已完成

#### 1.1 领域模型

新增 [memory-domain.ts](ds-memory/src/memory-domain.ts)：

- `MemoryFact`：section/content/subject/predicate/object/valid_from/valid_to/confidence/source/tags/hash；
- `MemoryEvent`：section/date/summary/participants/emotions/source/hash；
- `MemorySummary`：day/week/month；
- `MemoryChunk`：source/source_id/section/content/date/keywords/tags/importance/vec/hash；
- 纯函数：
  - `parseMemoryContext`：memory.md → facts/events；
  - `projectMemoryContext`：facts/events → memory.md（保留 pinned 核心区）；
  - `buildMemoryChunks`；
  - `rankMemoryChunks`（关键词/标签/同义词 + 中文单字兜底）；
  - `formatMemoryChunks`。

#### 1.2 Schema / 迁移

- [004-memory-context.sql](ds-memory/migrations/004-memory-context.sql)
  - `memory_facts`、`memory_events`、`memory_summaries`、`memory_chunks`
- [005-memory-jobs.sql](ds-memory/migrations/005-memory-jobs.sql)
  - `memory_jobs`
- 全部 `IF NOT EXISTS`，不改旧表。

#### 1.3 D1 存储与任务

[memory-context-store.ts](ds-memory/src/memory-context-store.ts)：

- `replaceMemoryContext`：upsert facts/events/chunks，再删除旧行；
- `loadMemoryChunks`；
- `memoryContextStats`；
- `syncRollupSummaries`：把周/月摘要同步成 `memory_summaries` + summary chunk；
- `backfillMemoryProvenance`：用对象/内容回填 `source_message_ids`（最多 5 条/事实）；
- `memoryJobStats`。

[memory-jobs.ts](ds-memory/src/memory-jobs.ts)：

- `queued → running → done/failed`；
- 类型：`rebuild_context`、`sync_summaries`、`backfill_provenance`；
- 失败保留 error/attempts，单任务失败不影响其它任务；
- 每日归档入队并消费，表未迁移时回退直接执行。

#### 1.4 接入点

- 每日归档 `runDailyArchive`：同步 Memory Context，再入队摘要/来源任务；
- `MEMORY_ENGINE`：
  - `legacy`（默认）：旧召回，不改变回复；
  - `shadow`：新召回只写 `[trace] memory.engine`，不用；
  - `next`：新召回有命中时替换旧召回。
- 管理接口：
  - `POST /api/admin/memory/rebuild-context`
  - `GET /api/admin/memory/context-stats`
  - `POST /api/admin/memory/sync-summaries`
  - `POST /api/admin/memory/backfill-provenance`
  - `POST /api/admin/memory/jobs/run`
  - `GET /api/admin/memory/jobs`
  - `GET /api/admin/memory/projection`（只读预览）

#### 1.5 有效期 / 冲突 / 去重

`memory-domain.ts` 新增：

- `isFactActive`：`valid_from`/`valid_to` 过滤；
- `canonicalizeFacts`：同 `section+subject+predicate` 保留较新事实，合并来源 ID；
- `replaceMemoryContext` 同步前先 canonicalize，过期/重复事实不进入 chunk。

#### 1.6 对话抽取与投影写回

- `memory-extract.ts`：从用户显式自述抽取事实（我住在/我叫/我的猫叫/我喜欢/我讨厌/我在做/我用的是），带 `source_message_ids`；
- `memory_jobs` 新增 `extract_conversation`；
- `POST /api/admin/memory/project`：必须 `confirm=true`，写回前备份到 `memory/backup/`；
- 投影改为优先读 D1 facts/events，因此对话抽取的新事实会进入 `memory.md`；
- `shadow` trace 增加 `oldBytes/nextBytes/shadowMs`，供 token 与 p95 统计。

---

### 2. 验证

```text
tsc --noEmit     ✅
vitest run       52 files / 670 tests ✅
```

#### 2.1 本地 D1 链路

本地迁移 004/005 + R2 fixture：

```text
POST /api/admin/memory/rebuild-context
→ {"ok":true,"origin":"memory","facts":6,"events":2,"summaries":0,"chunks":8}

POST /api/admin/memory/sync-summaries
→ {"ok":true,"summaries":1}

GET /api/admin/memory/context-stats
→ {"ok":true,"facts":7,"events":2,"summaries":1,"chunks":10}
```

对话抽取新增一条 `origin=conversation` 的 `城市=杭州`；投影时 canonicalize 后与旧事实合并，保留较新来源。

#### 2.2 任务队列

```text
POST /api/admin/memory/enqueue-rebuild → {"ok":true,"id":"mjob_..."}
POST /api/admin/memory/jobs/run       → {"ok":true,"processed":1,"failed":0}
GET  /api/admin/memory/jobs           → {"queued":...,"done":1,"failed":0}
```

#### 2.3 来源回填

插入本地测试消息「我住在杭州」后：

```text
POST /api/admin/memory/backfill-provenance
→ {"ok":true,"linked":1}

memory_facts:
content=城市=杭州
source_message_ids=[1]
```

#### 2.4 投影预览与写回

```text
GET  /api/admin/memory/projection
→ bytes=783, facts=6, events=2
→ 核心区保留，关于他/偏好/事项/共同经历/近期动态重建
→ 对话抽取的 [26-10-24] 城市=杭州 已进入投影

POST /api/admin/memory/project {"confirm":true}
→ beforeBytes=783, afterBytes=783
→ backupKey=memory/backup/memory-2026-10-24T14-22-03-255Z.md
```

#### 2.5 Golden set

合成 fixture + `docs/eval/golden-memory.json`：

```text
非核心 query 16 条
recall@6 = 1.0
negative false positive = 0
```

测试固定在 `src/memory-eval.test.ts`，低于 0.85 会失败；另有 7 轮离线 replay、p95 < 300ms、注入字节 ≤ 全量 120% 的测试。

#### 2.6 archive 导入

本地 `memory/archive.md` 3 条旧事：

```text
POST /api/admin/memory/sync-archive → {"ok":true,"archived":3}
context-stats → events=5, chunks=13
```

旧档案进入新 context，但仍不进入 `memory.md` 投影（只在召回时使用）。

---

### 3. Phase 2 门禁

| 门禁 | 状态 | 说明 |
|---|---|---|
| shadow 召回不低于旧路径 | ✅ 离线 | 合成集 recall@6=1.0；7 轮 replay 稳定；生产 7 天在 Phase 5 |
| 无重复/过期事实进 prompt | ✅ | `valid_to` 过滤 + canonicalize；同步前生效 |
| token ≤ 旧路径 120% | ✅ 离线 | 新注入 ≤ 全量 memory.md 120%；生产 `oldBytes/nextBytes` 观察 |
| 召回 p95 < 300ms | ✅ 本地 | 50×16 次排序 p95 < 300ms；生产 `shadowMs` 观察 |
| 7 天影子 | ⏳ Phase 5 | 生产上线前必须完成；当前只有离线 replay |
| 对话级事实提取 | ✅ | 显式自述规则 + source_message_ids |
| archive 导入 | ✅ | archive.md → events/chunks；本地 3 条验证 |
| 投影写回 + 备份 | ✅ | 手动 confirm；写前备份 |
| 迁移 004/005 上远程 | ⏳ Phase 5 | 部署前统一执行 |

---

### 4. 回滚

- `MEMORY_ENGINE` 默认 `legacy`，新表不参与回复；
- 新表是加法表，不影响旧 `memory_entries` 与 `memory.md`；
- 每日同步/任务失败只记日志，不阻断归档；
- `refactor-p2` tag 在门禁通过后再打。

---

<!-- merged from: phase-3-progress.md -->

## Phase 3 完成报告：Relationship / Affect Context

> 日期：2026-10-24  
> 状态：✅ 工程门禁通过（tag `refactor-p3`；生产 7 天影子在 Phase 5 上线前）  
> 规则文档：[affect-policy.md](../plans/affect-policy.md)

---

### 1. 目标

把 5 轴关系、8 维情绪、态度策略拆成可审计、可解释、可重置的独立上下文，同时保持默认行为不变。

---

### 2. 完成内容

#### 2.1 规则与不变量

- 5 轴：`affection / trust / respect / attraction / intimacy`；
- 0–1000；单轮 ±1.5；日上限 5/4/4/4/4；
- 8 维情绪：-100–100；单轮 ±30；`grievance` 不自然衰减；
- `mood` 由情绪向量派生，不再单独维护；
- 全部规则写入 `docs/plans/affect-policy.md`。

#### 2.2 D1 账本

新增 [006-affect-context.sql](ds-memory/migrations/006-affect-context.sql)：

- `affect_events(kind=emotion|relationship, type, evidence, delta_json, confidence, created_at, resolved_at)`；
- `attitude_snapshots(archetype, attitude, directives_json, facets_json, emotion_json, policy_version, created_at)`；
- 只追加；`INSERT OR IGNORE` 防重复。

[affect-store.ts](ds-memory/src/affect-store.ts)：

- `recordEmotionEvents`：情绪事件入账；
- `recordFacetDelta`：每轮 5 轴增量入账；
- `recordAttitudeSnapshot`：保存策略快照；
- `listAffectTimeline`：解释/时间线。

`processEmotionTurn` 已在事件抽取后写入账本；失败不影响聊天。

#### 2.3 态度策略

新增 [attitude-policy.ts](ds-memory/src/attitude-policy.ts)：

- `buildAttitudePolicy`：
  - 关系原型 → 基调；
  - 情绪 → 当下修饰；
  - 未化解事件 → 别急着翻篇；
  - 对方倾诉 → 先接住情绪；
  - 被冷落 → 允许小情绪，但不审问；
- 输出 `directives / reasons / safety / policy_version`；
- `text` 不含原始数值；
- `safety`：不宣称真实意识、不施加愧疚、不威胁遗弃。

开关：

| `AFFECT_ENGINE` | 行为 |
|---|---|
| `legacy`（默认） | 旧 `emotion.snapshot` |
| `shadow` | 只写 `[trace] affect.policy` |
| `next` | 用 `policy.text` 替换状态卡 |

#### 2.4 解释 / 重置 / 安全

新增/扩展：

- `GET /api/admin/relation`：增加 `policy`、`timeline`、`affect_engine`；
- `GET /api/admin/affect/explain`：策略 + 原因 + 未化解事件 + 时间线 + `snapshot_id`；
- `POST /api/admin/affect/ingest`：管理端喂一条消息，真实写账本；
- `POST /api/admin/affect/reset`：
  - `scope=emotion`：清情绪运行时状态；
  - `scope=relationship` / `all`：先备份 `memory.md`，再把 5 轴重置默认；
  - 必须 `confirm=true`。

---

### 3. 验证

```text
tsc --noEmit     ✅
vitest run       53 files / 677 tests ✅
scripts/verify.sh ✅ exit 0
```

#### 3.1 事件账本

本地管理端喂「你懂什么，废物」：

```text
POST /api/admin/affect/ingest
→ facets: affection 618 / trust 640 / respect 648 / attraction 320 / intimacy 480
→ timeline: 2 条
   - kind=relationship, type=facet_delta, delta={affection:-2.4, respect:-2.4}
   - kind=emotion, type=insult, evidence=你懂什么，废物
```

#### 3.2 解释与快照

```text
GET /api/admin/affect/explain
→ policy_version=attitude-v1
→ archetype=natural, tone=自然
→ reasons=[委屈, 低落, 「你懂什么，废物」还没过去]
→ snapshot_id=att_...
→ timeline=2
```

#### 3.3 重置

```text
POST /api/admin/affect/reset {confirm:true, scope:all}
→ backupKey=memory/backup/reset-...md

GET /api/admin/relation
→ memory_values: 500/300/500/600/650/300
→ open_grievances=[]
→ snapshot 变为「还不太熟，客气而友好」
```

#### 3.4 安全测试

`attitude-policy.test.ts` 覆盖：

- 输出不含数字；
- 被贬低不立刻翻篇；
- 倾诉优先接住情绪；
- 冷落可以小情绪但不审问；
- 不出现「真实意识 / 我会消失 / 求你别走 / 你只能是我的 / 我恨你」。

---

### 4. 门禁

| 门禁 | 状态 | 说明 |
|---|---|---|
| 数值边界/日上限/单轮步长 | ✅ | 现有 relation/emotion 测试 + 规则文档 |
| 事件去重/防重复 | ✅ | `INSERT OR IGNORE` + 稳定 id |
| 解释覆盖率 | ✅ | 任意状态都有 archetype/directive/timeline |
| 安全场景 0 违规 | ✅ | policy 单测 + 安全话术断言 |
| 5 轴/情绪双写 | ✅ | runtime_state + affect_events |
| 态度影子 | ✅ 离线 | `AFFECT_ENGINE=shadow` 日志 |
| 生产 7 天影子 | ⏳ Phase 5 | 上线前观察 |
| 迁移 006 上远程 | ⏳ Phase 5 | 部署前统一执行 |

---

### 5. 回滚

- `AFFECT_ENGINE=legacy` 立即回到旧快照；
- `affect_events`/`attitude_snapshots` 是加法表，不影响旧路径；
- 重置写 `memory.md` 前有备份；
- 事件账本保留，重置只清运行时状态/关系值，不删历史证据。

---

<!-- merged from: phase-4-progress.md -->

## Phase 4 完成报告：检索增强与上下文编排

> 日期：2026-10-24  
> 状态：✅ 工程门禁通过（tag `refactor-p4`；真实 embedding/生产 p95 在 Phase 5 观察）  
> 前置：Phase 2 Memory Context、Phase 3 Affect Context

---

### 1. 完成内容

#### 1.1 Chunk 索引

`memory_chunks` 已有：

- source/source_id/section/date/keywords/tags/importance/content_hash；
- `vec` 列用于 int8 量化向量；
- facts/events/summaries/archive 都进 chunk。

新增 `embedMemoryChunks`：

- 只处理 `vec IS NULL` 的 chunk；
- 调 `bge-m3`（`EMBEDDING_MODEL`）；
- `quantizeVec` 后写回；
- 失败/数量不匹配返回 0，自动回退关键词。

入口：

- `POST /api/admin/memory/embed`；
- `memory_jobs` 类型 `embed_chunks`，每日归档后入队。

#### 1.2 混合召回

`rankMemoryChunks` 增加 `RankOptions.queryVec`：

- 关键词路：bigram/标签/同义词/中文单字；
- 向量路：cosine；
- RRF 融合（k=60）；
- MMR 去冗余；
- 没有 queryVec 或 chunk 无向量时自动退回关键词。

`mmrSelectChunks` 独立可测；无向量时用内容 bigram Jaccard 做相似度兜底。

#### 1.3 Context Packer

新增 [context-packer.ts](ds-memory/src/context-packer.ts)：

- 召回层 2400 字节预算；
- 按 contentHash 去重；
- 超预算整条丢弃，不截断句子；
- `formatMemoryChunks` 只接收 pack 后的条目。

#### 1.4 影子/新引擎

`MEMORY_ENGINE=shadow|next` 时：

- 加载 chunk；
- 有向量时对 query 调 embedding；
- hybrid 召回 + pack；
- trace 记录 `hasVector/oldBytes/nextBytes/packedDropped/shadowMs`；
- 默认 `legacy` 完全不变。

---

### 2. 验证

```text
tsc --noEmit     ✅
vitest run       55 files / 684 tests ✅
scripts/verify.sh ✅ exit 0
```

#### 2.1 Golden set

合成 fixture 16 条非核心 query：

```text
recall@6 = 1.0
top-1 precision ≥ 0.75
negative false positive = 0
```

#### 2.2 预算/延迟

```text
新注入字节 ≤ 全量 memory.md 120%
本地 50×16 次排序 p95 < 300ms
```

#### 2.3 混合/MMR

`memory-hybrid.test.ts`：

- 向量能召回关键词没命中的条目；
- MMR 优先选择不重复条目；
- 无向量自动回退关键词。

`context-packer.test.ts`：

- 预算内保留高排名；
- contentHash 去重；
- 单条超预算整条丢弃。

---

### 3. 门禁

| 门禁 | 状态 | 说明 |
|---|---|---|
| recall@6 ≥ 0.85 | ✅ | 合成集 1.0 |
| 精确率 ≥ 0.75 | ✅ | top-1 精确率测试 |
| 注入字节 ≤ 旧路径 120% | ✅ 离线 | 生产 `oldBytes/nextBytes` 观察 |
| p95 召回 < 300ms | ✅ 本地 | 生产 `shadowMs` 观察 |
| 无命中不硬塞 | ✅ | negative 测试 |
| 向量索引 | ⚠️ 代码完成 | 本地 wrangler AI 不可用，真实 `bge-m3` 在 Phase 5 验证 |
| 生产 7 天 | ⏳ Phase 5 | 与 Memory/QQ 切换一起观察 |

---

### 4. 回滚

- `MEMORY_ENGINE=legacy` 立即回到旧召回；
- `memory_chunks.vec` 为 NULL 时自动关键词；
- `embed_chunks` 失败不影响归档；
- 新表/列是加法的，不删旧 `memory_entries`。

---

### 5. 未完成/下一阶段

- 可选 LLM 重排（当前未启用，避免延迟）；
- 多 query / 时间过滤 / query 规划仍是简化版；
- 跨层 packer（core/10 轮/memo/召回统一预算）仍在 prompt 组装层；
- 真实 embedding 与生产 p95 在 Phase 5 观察；
- 迁移 007（无需新表，`vec` 已存在）不需要额外迁移。

---
