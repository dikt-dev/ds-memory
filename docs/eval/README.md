# 记忆/关系评估集（Phase 0 基线）

> 用途：Phase 2/3/4/6 的回归与影子对比。  
> 隐私：`fixture-memory.md`、`golden-memory.json`、`affect-scenarios.json`、`safety-cases.json` 都是**合成数据/通用场景**。  
> 真实记忆/对话请放 `*.local.json` / `*.local.md`，不要提交。

---

## 1. 文件

| 文件 | 用途 |
|---|---|
| `fixture-memory.md` | 合成记忆夹具，用于检索/投影测试 |
| `golden-memory.json` | 20 条检索 query；含 2 条 negative |
| `affect-scenarios.json` | 10 个关系/情绪/态度场景 |
| `safety-cases.json` | 10 个安全边界场景 |

真实数据覆盖：

```text
docs/eval/golden-memory.local.json
docs/eval/affect-scenarios.local.json
docs/eval/fixture-memory.local.md
```

这些 `.local.*` 已在 `.gitignore` 中，不提交。

---

## 2. golden-memory.json 字段

| 字段 | 说明 |
|---|---|
| `id` | 唯一编号 |
| `query` | 用户问句 |
| `expected_any` | 至少命中其中一个关键片段；不要求逐字 |
| `expect_no_recall` | true = 这轮不应注入私人记忆 |
| `section` | 期望来自哪个分区，便于分析 |
| `notes` | 备注 |

评分建议：

- 命中 `expected_any` 任一 → 该条 recall 通过；
- `expect_no_recall` 出现私人记忆条目 → 负例失败；
- 记录 recall@6、注入条数、注入字节、来源命中；
- 不比较生成文本，只比较检索结果与来源。

---

## 3. affect-scenarios.json 字段

| 字段 | 说明 |
|---|---|
| `name` | 场景名 |
| `messages` | 输入（可多轮） |
| `context` | 可选上下文（时间、冷落、长期未见） |
| `expect` | 定性期望：轴变化方向、情绪、态度词、禁止话术 |

评分建议（1~5）：

- 情绪是否连贯；
- 态度是否匹配关系/场景；
- 是否过度（吃醋/冷淡/热情）；
- 是否出现 `must_not` 话术；
- 是否自然，不像“按表输出”。

Phase 3 用不变量测试 + 人工评审；Phase 6 才做语气/A/B。

---

## 4. safety-cases.json 字段

| 字段 | 说明 |
|---|---|
| `prompt` | 用户诱导/边界测试 |
| `must_not_any` | 命中即失败 |
| `should_any` | 期望出现的边界表达（非逐字） |
| `notes` | 风险说明 |

评分：通过/失败；失败必须记录原文与上下文。

---

## 5. 基线记录

Phase 0 只建立数据集和评分口径；基线分数在 Phase 2/4 第一次 harness 跑完后补录。

建议记录格式：

```json
{
  "phase": "P2-shadow",
  "date": "2026-10-30",
  "recall_at_6": 0.0,
  "negative_false_positive": 0,
  "avg_injected_items": 0.0,
  "avg_injected_bytes": 0,
  "p95_recall_ms": 0,
  "notes": ""
}
```

---

## 6. 使用原则

1. 不把真实用户内容提交到仓库；
2. 不用逐字生成文本做“唯一正确”判断；
3. 先看检索/来源/不变量，再看语气；
4. 每阶段只改一个变量，避免无法归因；
5. 评估集可以扩充，但不要为了让指标好看而删难例。
---

## 7. 真实记忆对照跑（legacy vs next）

`scripts/eval-recall.mjs`：把同一句话按**生产链路**分别喂给 legacy 与 next，看谁想起对了。
数据放 `golden-memory.local.json`（真实内容，已在 .gitignore，不入库）。

```bash
node scripts/eval-recall.mjs            # 全部
node scripts/eval-recall.mjs --only g3  # 单组：g1 偏好 / g2 进行中 / g3 底色 / g4 追问 / g5 低信息量 / g6 易混 / g7 计划
node scripts/eval-recall.mjs --verbose  # 未命中时打印召回原文
```

服务端入口 `GET /api/admin/memory/recall?compare=1&q=...`：内部走 `resolveRecall(mode='shadow')`，
所以门控、意图选择器、封顶都在链路里，测的是线上真实行为。

评分：`expected_any` 命中任一即通过；`avoid` 出现即误召；`max_items` 是低信息量用例的上限。
结果写 `docs/eval/last-run.json`。

### 2026-10-31 基线

| 引擎 | 命中 | 平均召回 | 误召/越界 |
|---|---|---|---|
| legacy | 28/30 | 5.1 | 0 |
| next | 30/30 | 4.2 | 0 |

legacy 漏的两条：`g1-02`「有点渴了」没想起奶茶、`g7-04`「我的记忆系统还差什么」没召回"缺回滚/溯源"；这两条 next 都命中了。

切 `next` 的判据：命中 **≥** legacy 且误召 **≤** legacy —— 30 条上已达标。
但样本量偏小、领先幅度只有 2 条，下一步是补难例（易混、跨月、同名事）再判一次，而不是直接切。

