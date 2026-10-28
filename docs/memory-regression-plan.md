# 记忆关联回归与来源追溯方案

日期：2026-10-28

适用范围：`memory_links`、`memory_audit`、shadow/next 记忆召回。

## 目标

验证两件事：

1. 关联扩展是否真的改善了“该想起/不该想起”；
2. 关联和来源是否可解释、可回滚，且不影响 legacy 回复。

## 当前已具备

- `memory_links`：事实→同实体事实、事实→同日事件；
- `expandLinkedChunks()`：只对已召回结果扩 1 跳，最多补 2 条；
- `memory.engine` trace：`linkedItems`；
- `memory_audit`：`/更正` 的前后 hash、来源、内容；
- 来源追溯接口：

```text
GET /api/admin/memory/links?type=fact&id=fact_xxx
```

返回直接关联、关联来源、两端内容和 `source_message_ids`。

## 回归集

从真实历史里挑固定样本，不临时生成：

### A. 同事件

```text
“上次去杭州那家店叫什么”
“楼外楼”
“游西湖”
```

检查：只提“西湖”时是否能通过同事件想起“楼外楼”。

### B. 同实体

```text
“作息”
“上班时间”
“下班时间”
```

检查：关联是否补到正确的作息事实，而不是把所有同 tag 的事实都塞进来。

### C. 不该关联

```text
“今天天气”
“写个快排”
“我回来了”
```

检查：回忆应保持空或只命中直接相关条目，关联不能引入无关长文。

### D. 冲突/更正

```text
旧：上班8:15
新：8:15出门，8:30上班
```

检查：旧条目不应因关联被带回；来源应指向新更正。

## 指标

每轮记录：

```text
recall_items
linked_items
linked_ratio
injected_chars
first_token_ms
```

离线对比 legacy 与 shadow：

- 命中率：人工标注“应该想起”的样本是否命中；
- 噪声率：关联带来的条目里无关比例；
- 去重率：关联目标是否与根集重复；
- 上下文成本：`injected_chars` 增量；
- 回复成本：首字延迟和单轮费用。

## 通过门槛

关联扩展进入 `next` 前必须满足：

```text
同事件样本命中率 >= 80%
同实体样本命中率 >= 80%
无关样本噪声率 <= 20%
平均 linked_items <= 2
平均 injected_chars 增量 <= 15%
首字延迟增量 <= 150ms
```

未达标则只保留在 shadow，不切 `next`。

## 回滚

- 代码回滚：关闭 `expandLinkedChunks()` 调用即可；
- 数据回滚：`memory_links` 可整体清空，不影响 `memory_facts/events`；
- 记忆回滚：`memory_audit` 记录 before/after hash，可按审计恢复；
- legacy 路径不读取 `memory_links`，不受影响。

## 待补

- 自动生成固定回归集；
- 在每日归档后跑一次离线评估；
- 把 `linked_items` 和噪声率写入 `engine_metrics`；
- 来源追溯 UI（当前只有 admin API）。
