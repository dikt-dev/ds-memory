# 记忆子系统代码评估核对（2026-10-29）

对 10/29 这份第三方评估逐条核对源码后的结论。**先说结论：技术判断约 8 成准确，
两处必须纠正，时间建议在观察期内不可执行。**

## 一、核对结果

| 编号 | 评估结论 | 核对 | 证据 |
|---|---|---|---|
| P1-1 | 召回无 deadline，串在首字路径上 | ✅ 成立（严重度略高） | `chat.ts:102` 在 `budgetContext` 之前；`memory-index.ts:493` 全表无 LIMIT |
| P1-2 | `expandLinkedChunks` N+1 | ✅ 成立 | `memory-links.ts:244-250` 循环内单查 |
| P1-3 | `putMemory` 无写后校验 | ✅ 成立 | 已修，见下 |
| P1-4 | 索引超 20MB 丢全部向量 | ⚠️ **病理方向说反** | 见第二节 |
| P1-5 | next/shadow 分支复制三份 | ✅ 成立 | `chat.ts:102-140` ≈ `openai.ts:559-600` |
| P1-6 | `origin` 语义混乱产生幽灵行 | ✅ 成立 | `memory-domain.ts:132` id 不含 origin；`memory-context-store.ts:143` 按 origin 清理 |
| P2-1 | 四套上限、两种单位 | ✅ 成立 | 16KB / 24576B / 24000B / 16KB / 12000 字符 / 4000 字符 |
| P2-2 | `dupOf` 未进入 next 链路 | ⚠️ **措辞需改** | 见第二节 |
| P2-3 | 死代码清单 | ❌ **误判一项** | `trimOldestEntries` 是活代码 |
| P2-4 | RMW 无锁 | ✅ 成立 | |
| P2-5 | legacy 未走 `shouldRecallMemory` | ✅ 成立 | `chat.ts:102` 早于 `:114` 的门控 |
| P2-6 | DB 耦合层几乎无测试 | ✅ 成立 | `memory-context-store.test.ts` 实际 19 行 |

## 二、两处必须纠正

### P2-3：`trimOldestEntries` 不是死代码

评估把它列进"仅定义无引用"，实际链路是：

```text
prompt.ts:158              → compactMemoryForPrompt(memory)
memory-maintenance.ts:48   → compactMemoryForPrompt()
memory-maintenance.ts:61   → trimOldestEntries(out, maxBytes)
```

这是提示词超限时的最后一道裁剪兜底，正在线上跑。真正死的是
`enforceSectionBudgets`、`applyRelationDelta`、`extractImmutableSection` /
`injectImmutableSection`、`recallForQuery`（连带 `pickRelevant` / `formatRecalledBlock`）。

按原清单去删会删掉唯一会真裁剪记忆的代码——"结论对、论据错"最危险。

### P2-2：不是算法分叉，是字段没搬过去

`MemoryChunk` 确实没有 `dupOf`，但 `recallMemoryForChat:729` 已经用 `!r.dupOf` 过滤，
legacy 也在享用语义去重。所以问题是 `memory_entries.dup_of` **列没被带进 chunk**，
同一份数据一个入口过滤、一个入口不过滤。修法是补字段，不是统一算法——成本差一个量级。

### P1-4：不是"永久退化"，是"每小时来回抖"

KV 只是缓存，`memory_entries.vec` 才是真相源。真实循环是：

```text
KV 过期(1h) → 回源 D1 带回 vec → 语义召回短暂正常
             → putIndexKv 又写一份无 vec 的 KV → 再次退化
```

**这比"永久退化"更难排查**：不会有稳定表现，只表现为"今天答得好、明天又忘"。
严重度被低估，病理方向被说反。

## 三、本次已改（冻结期内，未部署）

| 项 | 内容 | 影响面 |
|---|---|---|
| 死代码清理 | 删除 7 个无引用导出函数及其 16 个用例 | 零行为变化，tsc/vitest 验证 |
| P1-3 | `putMemory` 写后读回校验，返回 `boolean`；失败时保留旧缓存 | 仅每日 04:00 归档写回 |
| P1-3 配套 | `jobs.ts` 写回失败时跳过索引/context 重建 | 避免索引里出现 R2 中不存在的记忆 |
| 测试 | 新增 `memory.test.ts`（5 例：正常/put 失败/读回不一致/回源/首次为空） | 纯增量 |

删除的函数：`enforceSectionBudgets`、`applyRelationDelta`、`extractImmutableSection`、
`injectImmutableSection`、`recallForQuery`、`pickRelevant`、`formatRecalledBlock`。
`trimOldestEntries` **保留**（活代码）。

测试：63 文件 / **722** 用例通过，`tsc --noEmit` 零错误。

## 四、暂缓项与时间表

冻结期到 **2026-11-01 21:10**（Phase 5 七日 shadow 观察）。以下全部落在召回主干，
在观察期内动会让 7 天观测数据作废。

### 解冻后第一批（11-01 晚，改召回，必须一起上）

| 序 | 项 | 预计 | 为什么放一起 |
|---|---|---|---|
| 1 | P2-5 legacy 也走 `shouldRecallMemory` | ~10 行 | 直接改变召回触发分布 |
| 2 | P1-1 recall 包 800ms deadline | ~20 行 | 超时返回空 = 合法的空召回 |
| 3 | P1-5 抽 `runMemoryEngine` | ~1 天 | 三项都改同一段代码，分开改三次 |

上线方式：一次部署，观察 `engine_metrics.ms` 的 P50/P95 变化。

### 切 next 之前（11-02 ~ 11-04，硬性前置）

| 序 | 项 | 理由 |
|---|---|---|
| 4 | P1-6 origin 对账 + conversation TTL | 不修就会把脏数据喂给 next |
| 5 | P2-2 把 `dup_of` 带进 `MemoryChunk` | 两条链路对"重复"的判定要一致 |
| 6 | P1-2 `expandLinkedChunks` 改批量 IN | 切 next 后单轮最多 ~48 次 D1 往返 |

### 11-05 ~ 11-07（容量与一致性）

| 序 | 项 |
|---|---|
| 7 | P1-4 索引 KV 分片（或超限直接不写、全走 D1） |
| 8 | P2-1 上限阈值归一，命名带单位 |
| 9 | P2-6 补 `replaceMemoryContext` / `applyMemoryCorrection` 的 mock D1 测试 |
| 10 | P2-4 `memory.md` 写锁 / 版本号 |

### 未验证（别当结论用）

- P1-1/P1-2 的延迟影响是代码结构推断，**没有实测**；应查 `engine_metrics.ms` 取真数。
- `memory_entries` / `memory_chunks` 当前实际行数未知，P1-4 是"到量会炸"不是"正在炸"。
- 情感/态度/主动消息的内部逻辑未评估。
