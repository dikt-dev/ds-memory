# Phase 2 进度报告（2A 内核 + 2B 任务/来源/评测 + 门禁增量）

> 日期：2026-10-24  
> 状态：🚧 Phase 2 门禁未过（核心与门禁增量完成；未打 `refactor-p2` tag）  
> 目标：把记忆从“行文本”提升为 facts / events / summaries / chunks，并建立可影子对比的读写管线。

---

## 1. 已完成

### 1.1 领域模型

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

### 1.2 Schema / 迁移

- [004-memory-context.sql](ds-memory/migrations/004-memory-context.sql)
  - `memory_facts`、`memory_events`、`memory_summaries`、`memory_chunks`
- [005-memory-jobs.sql](ds-memory/migrations/005-memory-jobs.sql)
  - `memory_jobs`
- 全部 `IF NOT EXISTS`，不改旧表。

### 1.3 D1 存储与任务

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

### 1.4 接入点

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

### 1.5 有效期 / 冲突 / 去重

`memory-domain.ts` 新增：

- `isFactActive`：`valid_from`/`valid_to` 过滤；
- `canonicalizeFacts`：同 `section+subject+predicate` 保留较新事实，合并来源 ID；
- `replaceMemoryContext` 同步前先 canonicalize，过期/重复事实不进入 chunk。

### 1.6 对话抽取与投影写回

- `memory-extract.ts`：从用户显式自述抽取事实（我住在/我叫/我的猫叫/我喜欢/我讨厌/我在做/我用的是），带 `source_message_ids`；
- `memory_jobs` 新增 `extract_conversation`；
- `POST /api/admin/memory/project`：必须 `confirm=true`，写回前备份到 `memory/backup/`；
- 投影改为优先读 D1 facts/events，因此对话抽取的新事实会进入 `memory.md`；
- `shadow` trace 增加 `oldBytes/nextBytes/shadowMs`，供 token 与 p95 统计。

---

## 2. 验证

```text
tsc --noEmit     ✅
vitest run       52 files / 667 tests ✅
```

### 2.1 本地 D1 链路

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

### 2.2 任务队列

```text
POST /api/admin/memory/enqueue-rebuild → {"ok":true,"id":"mjob_..."}
POST /api/admin/memory/jobs/run       → {"ok":true,"processed":1,"failed":0}
GET  /api/admin/memory/jobs           → {"queued":...,"done":1,"failed":0}
```

### 2.3 来源回填

插入本地测试消息「我住在杭州」后：

```text
POST /api/admin/memory/backfill-provenance
→ {"ok":true,"linked":1}

memory_facts:
content=城市=杭州
source_message_ids=[1]
```

### 2.4 投影预览与写回

```text
GET  /api/admin/memory/projection
→ bytes=783, facts=6, events=2
→ 核心区保留，关于用户/偏好/事项/共同经历/近期动态重建
→ 对话抽取的 [26-10-24] 城市=杭州 已进入投影

POST /api/admin/memory/project {"confirm":true}
→ beforeBytes=783, afterBytes=783
→ backupKey=memory/backup/memory-2026-10-24T14-22-03-255Z.md
```

### 2.5 Golden set

合成 fixture + `docs/eval/golden-memory.json`：

```text
非核心 query 16 条
recall@6 = 1.0
negative false positive = 0
```

测试固定在 `src/memory-eval.test.ts`，低于 0.85 会失败。

---

## 3. Phase 2 门禁未过项

| 门禁 | 状态 | 说明 |
|---|---|---|
| shadow 召回不低于旧路径 | ⏳ | 合成集 1.0；真实 7 天影子未跑 |
| 无重复/过期事实进 prompt | ✅ | `valid_to` 过滤 + canonicalize；同步前生效 |
| token ≤ 旧路径 120% | ⏳ | 已记录 oldBytes/nextBytes；缺 7 天样本 |
| 召回 p95 < 300ms | ⏳ | 已记录 shadowMs；缺线上样本 |
| 7 天影子 | ⏳ | 需要线上/回放数据；当前只有合成集 |
| 对话级事实提取 | ✅ | 显式自述规则 + source_message_ids |
| archive 导入 | ⏳ | 旧档案尚未进入新 context（Phase 4） |
| 投影写回 + 备份 | ✅ | 手动 confirm；写前备份 |
| 迁移 004/005 上远程 | ⏳ | Phase 5 部署前统一执行 |

---

## 4. 回滚

- `MEMORY_ENGINE` 默认 `legacy`，新表不参与回复；
- 新表是加法表，不影响旧 `memory_entries` 与 `memory.md`；
- 每日同步/任务失败只记日志，不阻断归档；
- `refactor-p2` tag 在门禁通过后再打。
