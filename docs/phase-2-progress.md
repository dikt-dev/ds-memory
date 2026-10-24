# Phase 2 进度报告（2A：Memory Context 内核）

> 日期：2026-10-24  
> 状态：🚧 进行中（Phase 2A 完成；未打 `refactor-p2` tag）  
> 目标：把记忆从“行文本”提升为 facts / events / summaries / chunks，并建立可影子对比的读写管线。

---

## 1. 本阶段完成

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
  - `rankMemoryChunks`；
  - `formatMemoryChunks`。

### 1.2 Schema / 迁移

新增 [migrations/004-memory-context.sql](ds-memory/migrations/004-memory-context.sql)：

- `memory_facts`
- `memory_events`
- `memory_summaries`
- `memory_chunks`

全部 `IF NOT EXISTS`，不改旧表。

### 1.3 D1 存储

新增 [memory-context-store.ts](ds-memory/src/memory-context-store.ts)：

- `replaceMemoryContext`：upsert 当前 facts/events/chunks，再删除旧行；
- `loadMemoryChunks`；
- `memoryContextStats`。

### 1.4 接入点

- 每日归档 `runDailyArchive`：写完 `memory.md` 后同步 Memory Context；
- `POST /api/admin/memory/rebuild-context`：手动重建；
- `GET /api/admin/memory/context-stats`：查看规模；
- `MEMORY_ENGINE`：
  - `legacy`（默认）：旧召回，不改变回复；
  - `shadow`：新召回只写 `[trace] memory.engine`，不用；
  - `next`：新召回有命中时替换旧召回。

---

## 2. 验证

```text
tsc --noEmit     ✅
vitest run       48 files / 653 tests ✅
```

本地迁移 004 + 本地 R2 fixture 后：

```text
POST /api/admin/memory/rebuild-context
→ {"ok":true,"origin":"memory","facts":6,"events":2,"summaries":0,"chunks":8}

GET /api/admin/memory/context-stats
→ {"ok":true,"facts":6,"events":2,"summaries":0,"chunks":8}
```

说明：facts/events/chunks 的 D1 写入、读取、统计链路已通。

---

## 3. 尚未完成（Phase 2B）

| 项 | 说明 |
|---|---|
| `memory_jobs` | 异步重建任务表/消费器尚未建 |
| 对话级事实/事件抽取 | 目前只从 memory.md 导入，`source_message_ids` 为空 |
| archive 导入 | 旧档案尚未进入 facts/events/chunks |
| summaries 写入 | 表已建，未从日/周/月摘要填充 |
| 投影上线 | `projectMemoryContext` 已有测试，未用于写回 memory.md |
| 影子指标基线 | 未用真实查询跑 recall@6/注入字节对比 |
| `next` 验证 | 未在真实聊天中启用；默认仍是 `legacy` |
| 生产迁移 | 004 未上远程 |

---

## 4. 回滚

- `MEMORY_ENGINE` 默认 `legacy`，新表不参与回复；
- 新表是加法表，删除/保留都不影响旧 `memory_entries` 与 `memory.md`；
- 每日同步失败只记日志，不阻断归档；
- `refactor-p2` tag 会在 2B 门禁通过后再打。
