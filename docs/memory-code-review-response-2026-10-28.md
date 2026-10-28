# 记忆代码评估复核报告

日期：2026-10-28

对照 HEAD：`f58d73e`

评估来源：用户提供的《记忆代码评估（2026-10-28）》。

---

## 0. 结论

这份评估**总体准确**，尤其是 P0-1、P0-2、P0-3，都是真实问题，不是理论风险。

但它不等于“全部都要立刻改”。我的判断是：

```text
必须改：P0-1、P0-2、P0-3、P2-3 隐私
尽快改：P1-1、P1-3、P1-4
观察后再改：P1-2、P2-1、P2-2
清理项：P2-4
```

不需要重写记忆架构；需要修的是：

1. 预算函数名不副实；
2. 用户更正分区没有进入正式语义；
3. 月度合并被跨天重复卡死；
4. 隐私快照没被忽略；
5. 两条召回链对无日期条目的理解不一致。

---

## 1. 逐项复核

| 评估项 | 复核结论 | 处理 |
|---|---|---|
| P0-1 context-budget core 吃预算 | **确认** | 必改 |
| P0-2 用户更正分区被丢 | **确认** | 必改 |
| P0-3 月度合并跨天重复卡死 | **确认** | 11/01 前必改 |
| P1-1 无日期条目两套语义 | **确认** | 尽快 |
| P1-2 memory_jobs 无清理 | **确认** | 观察后 |
| P1-3 linkAllFacts 成本可疑 | **确认** | 尽快 |
| P1-4 webproactive 未接预算 | **确认** | 尽快 |
| P2-1 O(n)+O(n²) | **方向确认**，具体数字未复测 | 规模前处理 |
| P2-2 legacy/next 可能重复 | **可能**，next 开启前验证 | 切 next 前 |
| P2-3 隐私快照未忽略 | **确认，已先处理** | 已完成 |
| P2-4 死代码/注释漂移 | **基本确认** | 低优先级 |

---

## 2. P0 级：必须修

### P0-1 分层预算没有保护“固定记忆”

**确认。**

`context-budget.ts`：

```ts
let remaining = Math.max(0, maxChars - core.length);
```

core 会先吃掉总预算；core 足够大时，recent/rollup/recall 全部为 0。

这违背了两个地方写下的承诺：

- `context-budget.ts` 注释“固定记忆永不裁剪”；
- `memory-backlog.md` 验收“固定记忆不被裁掉”。

评估里的实测方向正确：memory.md 越大，召回越容易被挤掉，恰好是 compact 模式最需要召回的阶段。

补充一个评估没有提到的点：

- `extractPromptMemory()` 在超过 16KB 时已经会压缩；
- 但 `budgetContext` 看到的 `core` 是压缩后的文本，仍然可能大于 10k 总预算；
- 所以“core 体积”和“最终注入体积”确实可能不一致。

**修复方案**

```text
core 单独上限，不参与总预算
sub-budgets: core / recent / rollup / recall 不可互借
总预算只管 recent/rollup/recall
core 超限时先 compact，再注入
```

预计 1–2 小时，低风险。

---

### P0-2 `用户更正` 没有进入正式分区

**确认。**

`MEMORY_SECTION_ORDER` 没有 `用户更正（最高优先级）`，`STABLE_SECTIONS` 也没有。

后果：

- `projectMemoryContext` 投影时丢弃；
- compact 模式不注入；
- `reassemble` 遇到未知分区会排到末尾；
- 用户主动纠正反而最容易被系统丢掉。

**修复方案**

把 `用户更正（最高优先级）` 作为正式分区加入：

```text
MEMORY_SECTION_ORDER
STABLE_SECTIONS
投影白名单
reassemble 顺序
```

或者更彻底：`applyMemoryCorrection` 的带键纠正直接落到对应正式分区，只有无键纠正才进“用户更正”。

建议先做前者，改动小、可测试。

预计半天，低中风险。

---

### P0-3 月度合并被跨天重复卡死

**确认。**

`archiveOneDay` 会把下一天的 AI 回复补进当天日志；下一天日志本来也有这条回复。

`mergeDailyLogs`：

```ts
expected += log.messages.length   // 按未去重累加
map.set(m.id, m)                  // 按 id 去重
```

`mergeMonth`：

```ts
if (all.length !== expected) throw
```

跨天重复时 `all.length < expected`，直接硬失败。

11/01 是第一次真实月度合并，这个坑会在当天暴露。

**修复方案**

不要按“未去重总数”硬校验。改成：

```text
去重后 id 连续
合并数量不少于任一单日文件
允许 0..N 条跨天重复
重复项必须 id 相同且内容一致
```

或者显式记录跨天补全的 id，从 expected 里扣掉。

预计 1 小时，必须在 11/01 04:00 前完成。

---

## 3. P1 级：尽快改，但不必今天全做

### P1-1 无日期条目两套语义

**确认。**

`parseMemoryContext` 的 `ENTRY_RE` 要求日期前缀；`parseMemoryEntries` 允许 `date=null`。

所以：

```text
- 城市=杭州
```

legacy 进索引，next 忽略。

真实 memory.md 的称呼、雷区、人物底色等区域有大量无日期条目。切 next 前必须对齐。

**建议**

- 优先：next 也接受无日期条目，`valid_from=null`；
- 或者：归档/投影时强制补日期；
- 不要等到切 next 当天才发现记忆“消失”。

### P1-2 memory_jobs 无清理

确认只增不减。

不是当前故障，但应加：

```text
done/failed 超过 30 天删除
```

`memory_links`、`memory_audit` 也同样需要保留策略。

### P1-3 linkAllFacts 在每日重建路径上

确认：

- `replaceMemoryContext` 每次调用 `linkAllFacts`；
- `insertFacts` 又逐条 `linkFactToNeighbors`；
- `tags LIKE '%tag%'` 无索引，全表扫。

当前 18 facts 无害，但设计上应改成：

```text
只对新 fact 增量建链
手动 rebuild 才跑 linkAllFacts
tags 建索引或拆 tag 表
```

### P1-4 webproactive 没接预算

确认。

`budgetContext` 只进了 `chat.ts` / `openai.ts`；`webproactive.ts` 仍用原始 `promptMemory.text` / `recalled`。

主动消息是 cron 链路，最容易吃 Worker CPU 限额。

**建议**：把同样的 `budgetContext` 接到 proactive prompt。

---

## 4. P2 级：规模/清理项

### P2-1 O(n) + O(n²)

方向确认。

具体毫秒数未在本次复核中重跑，但结构问题成立：

- 每次召回全量 `bigrams`；
- `mmrSelectChunks` 某些调用点拿未截断池；
- `loadMemoryChunks` 默认 1000。

**建议**

- 候选先截断到 20–50 再做 MMR；
- per-chunk bigram 缓存；
- 观察 `CANDIDATE_TOP_K` 调大后的回归。

### P2-2 legacy/next 重复

可能是真的，但只在 next 生效且 legacy 结果仍兜底时出现。

shadow 阶段不注入，暂时无害。切 next 前用回归集验证。

### P2-3 隐私快照

**确认，已先处理。**

处理：

- `.gitignore` 增加 `memory.*.md`、`*.local.md`；
- 根目录 `memory.after-1027.md` 移到 `backups/memory-after-1027.private.md`；
- `backups/` 已在忽略列表。

### P2-4 死代码

基本确认，低优先级。

不建议在观察期大规模删代码；可以先标记，等记忆重构时一起清理。

---

## 5. 测试评估

评估说得对：

- 纯函数测试质量高；
- DB/归档链路测试少；
- `memory-links.ts` 目前 0 测试；
- `memory-correction.ts` 无测试；
- 回归样本只有 4 条。

建议补测试的顺序：

1. `mergeMonth` 跨天重复；
2. `context-budget` core 上限；
3. `用户更正` 投影/compact 保留；
4. `memory-links` 的关联生成与扩展；
5. `memory-correction` 的 keyed/无键路径。

---

## 6. 修改顺序建议

### 今天 / 11/01 前

```text
1. P0-3 月度合并校验（1h）
2. P0-1 context-budget core 上限（1–2h）
3. P0-2 用户更正正式分区（半天）
4. P2-3 隐私（已完成）
```

### 本周

```text
5. P1-1 无日期条目语义对齐
6. P1-4 webproactive 预算
7. P1-3 关联只做增量
```

### 观察期后

```text
8. P1-2 清理任务
9. P2-1 召回性能
10. P2-2 legacy/next 去重
11. P2-4 死代码清理
12. 补 DB/归档链路测试
```

---

## 7. 最终判断

需要修改，但不是“大改”。

这份评估最有价值的地方是指出了：

```text
我们声称保护的语义，代码没有真正保护
```

具体是：

- 声称 core 不裁，实际 core 吃预算；
- 声称用户更正最高优先级，实际投影/compact 会丢；
- 声称月度合并防丢数据，实际跨天重复会硬失败。

这三项都应该在 11/01 前修掉。其余性能、清理、测试项按 backlog 排期。

**本轮只出了报告，并先处理了 P2-3 隐私文件；代码修复尚未开始。**

---

## 8. 修复结果（2026-10-28 更新）

已修：

- P0-1 `context-budget` core 独立上限；
- P0-2 `用户更正（最高优先级）` 正式分区；
- P0-3 `mergeDailyLogs` 容错跨天合法重复；
- P1-1 无日期条目进入 facts；
- P1-4 `webproactive` 接入预算；
- P2-3 隐私快照移出仓库并加入 ignore。

未修/归档：

- P1-2 jobs/links/audit 清理；
- P1-3 `linkAllFacts` 增量优化；
- P2-1 召回性能；
- P2-2 legacy/next 去重；
- P2-4 死代码清理；
- DB/归档链路测试专项。

验证：

```text
712 → 717 tests passed
tsc --noEmit 0 error
server deployed: 6c36cbe5
```

详细排期见 `docs/pending-work.md`。
