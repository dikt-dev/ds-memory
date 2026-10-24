# Phase 4 完成报告：检索增强与上下文编排

> 日期：2026-10-24  
> 状态：✅ 工程门禁通过（tag `refactor-p4`；真实 embedding/生产 p95 在 Phase 5 观察）  
> 前置：Phase 2 Memory Context、Phase 3 Affect Context

---

## 1. 完成内容

### 1.1 Chunk 索引

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

### 1.2 混合召回

`rankMemoryChunks` 增加 `RankOptions.queryVec`：

- 关键词路：bigram/标签/同义词/中文单字；
- 向量路：cosine；
- RRF 融合（k=60）；
- MMR 去冗余；
- 没有 queryVec 或 chunk 无向量时自动退回关键词。

`mmrSelectChunks` 独立可测；无向量时用内容 bigram Jaccard 做相似度兜底。

### 1.3 Context Packer

新增 [context-packer.ts](ds-memory/src/context-packer.ts)：

- 召回层 2400 字节预算；
- 按 contentHash 去重；
- 超预算整条丢弃，不截断句子；
- `formatMemoryChunks` 只接收 pack 后的条目。

### 1.4 影子/新引擎

`MEMORY_ENGINE=shadow|next` 时：

- 加载 chunk；
- 有向量时对 query 调 embedding；
- hybrid 召回 + pack；
- trace 记录 `hasVector/oldBytes/nextBytes/packedDropped/shadowMs`；
- 默认 `legacy` 完全不变。

---

## 2. 验证

```text
tsc --noEmit     ✅
vitest run       55 files / 684 tests ✅
scripts/verify.sh ✅ exit 0
```

### 2.1 Golden set

合成 fixture 16 条非核心 query：

```text
recall@6 = 1.0
top-1 precision ≥ 0.75
negative false positive = 0
```

### 2.2 预算/延迟

```text
新注入字节 ≤ 全量 memory.md 120%
本地 50×16 次排序 p95 < 300ms
```

### 2.3 混合/MMR

`memory-hybrid.test.ts`：

- 向量能召回关键词没命中的条目；
- MMR 优先选择不重复条目；
- 无向量自动回退关键词。

`context-packer.test.ts`：

- 预算内保留高排名；
- contentHash 去重；
- 单条超预算整条丢弃。

---

## 3. 门禁

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

## 4. 回滚

- `MEMORY_ENGINE=legacy` 立即回到旧召回；
- `memory_chunks.vec` 为 NULL 时自动关键词；
- `embed_chunks` 失败不影响归档；
- 新表/列是加法的，不删旧 `memory_entries`。

---

## 5. 未完成/下一阶段

- 可选 LLM 重排（当前未启用，避免延迟）；
- 多 query / 时间过滤 / query 规划仍是简化版；
- 跨层 packer（core/10 轮/memo/召回统一预算）仍在 prompt 组装层；
- 真实 embedding 与生产 p95 在 Phase 5 观察；
- 迁移 007（无需新表，`vec` 已存在）不需要额外迁移。
