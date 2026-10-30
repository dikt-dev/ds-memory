# 记忆系统未完成项

更新：2026-10-28（2026-10-30 核对：条目仍有效）

状态说明：本文件只记录尚未实施的事项。已完成项见 `docs/memory/memory-project-comparison.md` 的“已落地”和 `docs/phases/phase-5/phase-5-observation-day3.md`。

> 统一排期与“什么时候开始做”见 [pending-work.md](../pending-work.md)；本文件保留技术细节。

## 总览

| 编号 | 事项 | 优先级 | 风险 | 当前状态 |
|---|---|---|---|---|
| M-01 | 分层上下文预算 + 注入清单 | P0 | 低 | 已完成基础版 |
| M-02 | 自动回归集与每日离线评估 | P0 | 低 | 骨架已完成；每日执行待做 |
| M-03 | 跨日期近重复事实合并 | P1 | 中 | 待做 |
| M-04 | FTS/CJK 兜底 | P2 | 中 | 待验证收益 |
| M-05 | 记忆查看/编辑 UI | P1 | 中 | 待产品迭代 |
| M-06 | 静默结束后的主动消息暂停 | P2 | 中 | 暂缓 |
| M-07 | BaiShou / Companion 源码补齐 | P2 | 低 | Companion 已读；BaiShou 待补 |
| M-08 | 记忆来源追溯 UI | P2 | 低中 | 待做 |

---

## M-01 分层上下文预算 + 注入清单

### 已完成（2026-10-28）

- `context-budget.ts`：core / recent / rollup / recall 分层装填；
- 固定记忆不裁剪；
- 超预算时先裁 recall，再裁 rollup，最后裁 recent；
- `openai.context` / `chat.context` trace 增加：
  - `budgetChars`
  - `budget`（各块 included/original/trimmed）
- 单测覆盖优先级和清单。

### 现状

已有基础限制：

```text
memory.md 全量上限 16KB
历史轮数 + 字符预算
context-packer 打包召回片段
```

缺少：

- 核心记忆 / 近期摘要 / 周月 rollup / 召回片段各自预算；
- 超预算时丢弃顺序；
- 每轮实际注入了哪些块、各多少字符。

### 方案

```text
固定记忆（称呼/底线/长期偏好）：约 2–3k 字符
近期摘要：约 2k
周/月 rollup：约 2k
召回片段：约 4k
总预算：约 10k 字符
```

每轮记录：

```text
memory.core_chars
memory.recent_chars
memory.rollup_chars
memory.recall_chars
memory.linked_items
memory.dropped_items
```

### 验收

- 总注入字符不超过预算；
- 固定记忆不被裁掉；
- 超预算时优先裁旧召回，不裁核心；
- trace 能还原本轮注入清单。

### 回滚

- 只改预算和 trace，不切记忆引擎；
- 关闭预算函数即恢复当前行为。

---

## M-02 自动回归集与每日离线评估

### 已完成（骨架）

- `scripts/memory-regression-cases.json`：固定样本；
- `scripts/memory-regression.mjs`：只读召回、校验 expect/forbid/linked 上限；
- `npm run memory:regression`；
- `GET /api/admin/memory/recall` 只读接口；
- 当前 4 条样本全部通过。

### 现状

已有回归方案：

```text
docs/plans/memory-regression-plan.md
```

但还没有固定样本和自动执行。

### 方案

1. 建立固定样本集：
   - 同事件：西湖/楼外楼；
   - 同实体：作息/上班/下班；
   - 无关：天气/快排/我回来了；
   - 冲突：旧作息 vs 新作息。
2. 每个样本人工标注“应该召回哪些记忆”。
3. 每日归档后跑一次离线评估：
   - 不写入用户记忆；
   - 输出命中率、噪声率、linked_items、注入字符；
   - 结果写入 `engine_metrics` 或单独表。
4. 设通过门槛后再考虑 `next`。

### 验收

- 样本集 ≥ 20 条；
- 每日自动跑；
- 连续 3 天指标稳定；
- 噪声率超阈值时有告警或记录。

### 回滚

- 评估只读，不影响线上；
- 可随时暂停 cron。

---

## M-03 跨日期近重复事实合并

### 现状

`canonicalizeFacts()` 已做：

- 同槽位去重；
- 新事实覆盖旧事实；
- 来源消息合并。

缺的是不同日期、不同槽位但语义相同的事实合并。

### 为什么不能直接做

错误合并会制造记忆冲突，例如：

```text
“我喜欢猫”
“我喜欢猫但不想养”
```

不能只靠 hash 或相似度直接覆盖。

### 方案

1. 先用 embedding 计算近重复候选；
2. 只对“同 section + 同 subject/predicate + 高相似度”生成候选；
3. 候选先进入待审队列，不直接删除；
4. 合并时保留来源消息 id 和两个版本的时间；
5. 冲突时保留新旧两条，标记 `valid_to`，不静默覆盖。

### 验收

- 近重复率下降；
- 不误合并“喜欢猫/不想养”这类反例；
- 合并后来源可追溯；
- 可回滚到合并前。

---

## M-04 FTS/CJK 兜底

### 现状

已有：

```text
bigram
CJK 分词
关键词 + 向量混合
关键词召回
```

FTS5 不是明显增量。

### 待验证

- D1 是否支持 FTS5 虚拟表；
- FTS 对短中文查询是否优于现有 bigram；
- 维护成本是否值得。

### 方案

先做离线对比：

```text
现有 keyword recall
vs FTS5 + CJK ngram
```

只有 FTS 在“无向量/弱关键词”样本上明显更好时才引入。

### 验收

- 有对比数据；
- 不增加明显的双写不一致；
- 失败时回退关键词。

---

## M-05 记忆查看/编辑 UI

### 范围

App/Web：

- 记忆列表；
- 搜索；
- 单条编辑/删除；
- 跳回来源消息；
- 关联查看；
- 更正审计。

### 为什么单独做

这是完整产品功能，不是后端记忆逻辑；需要界面、权限、误操作保护。

### 验收

- 用户能看到 AI 记住了什么；
- 能跳回来源；
- 更正后能立即生效；
- 删除/修改有审计。

---

## M-06 静默结束后的主动消息暂停

### 现状

当前只做到：

```text
这一轮 AI 不回复
```

未做：

```text
静默结束 → 记录 closed_at
主动消息检查 closed_at → 暂停
用户再次发言 → 解除
```

### 风险

用户说“晚安，明天见”后，随机主动消息仍可能在夜里发出。

### 方案

- 静默结束时写 `conversation:closed_until`；
- 主动消息发送前检查；
- 用户新消息解除；
- 早晨/固定问候可配置是否豁免。

### 状态

用户要求先暂缓，等静默结束稳定后再做。

---

## M-07 BaiShou / Companion 源码补齐

### 现状

- BaiShou-Next：clone 不完整；
- Companion-AI-Memory-Context-Token-Optimization：已补充并阅读 README/设计文档（2026-10-28）；仓库目前是设计规范/提示词/示例，尚无宿主实现。

### 待办

- 重新完整拉取 BaiShou；
- 搜索 Companion 仓库；
- 只补对比文档，不直接改代码。

---

## M-08 记忆来源追溯 UI

### 现状

已有 admin API：

```text
GET /api/admin/memory/links?type=fact&id=fact_xxx
```

返回关联、来源和 source_message_ids。

缺少用户可用的 UI：

- 在 App/Web 查看某条记忆的来源；
- 查看关联链；
- 查看修改审计；
- 一键跳回原消息。

### 依赖

依赖 M-05 的记忆查看 UI。

---

## 建议顺序

```text
1. M-01 分层预算 + 注入清单
2. M-02 自动回归集
3. M-03 近重复合并
4. M-05 / M-08 UI
5. M-04 FTS 对比
6. M-06 主动消息暂停
7. M-07 源码补齐
```

M-01、M-02 不改线上行为，适合先做。
