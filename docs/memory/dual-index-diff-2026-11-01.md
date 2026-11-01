# legacy / next 双索引比对 · 2026-11-01

> 目的：回答「能不能切 `MEMORY_ENGINE=next`」。
> 工具：`scripts/dual-diff.mjs`（一次性诊断，不挂 Worker）
> 前置：`src/memory-dual.ts` 的行数对账（KV `memory:dual=1`）

---

## 一、结论

**差异是结构性的，不是内容丢失。可以切。**

```
legacy 97 条 / next 96 条
只在 legacy：6    只在 next：5    两边都有：91
```

91/97 完全一致（归一化后按 `section|content` 比对）。差异 10 条，全部可解释。

---

## 二、差异明细

### 只在 legacy（6 条）

全部集中在「回滚方案」这一件事上，而且是同一件事的不同阶段：

```
[搁置]     回滚方案草稿：用户多次拖延…
[搁置]     回滚方案草稿:用户仍拖延未写…
[进行中]   用户想学记忆管理系统…
          用户写完了回滚方案草稿（memory-rollback-plan.md…）
          回滚流程:用户称今日已跑完一遍无问题…
[近期动态] 用户写完回滚草稿+TASKS 排期…
```

**这是 legacy 还没被清理留下的历史残留。** next 里对应的是一条：

```
[已完成] 回滚方案落地了：每日快照 + 恢复接口，不做版本历史…
```

### 只在 next（5 条）

两类：

| 类型 | 例子 | 性质 |
|---|---|---|
| 结构化抽取 | `喜欢=你`、`喜欢=看he的番` | 粒度不同，legacy 本来就没有这种形态 |
| 摘要压缩 | 「赛博搬家完成…」「10/21-10/25深圳…」 | 一段历史被压成一行 |

---

## 三、为什么「数量对齐」不能用来说等价

两套索引本就不该一样：

- legacy（`memory_entries`）保留每一条历史行
- next（`memory_chunks`）由每天的 `collapseOngoing` 合并同一事项的多个阶段，**是有损的**

数量对账（`memory-dual.ts`）的价值不是证明等价，而是**回归检测**：以后每次重建都能发现数量突变。

---

## 四、切换前的那个真问题

不是「两边是否一致」，而是：

> 合并后丢掉的中间状态，还需要吗？

按现有设计（distill 规则「同一件事只留一行」+ 每日 04:00 collapse），不需要。

---

## 五、切之前的清单

- [ ] 把 `MEMORY_ENGINE` 切到 next，legacy 分支保留只读兜底一周
- [ ] 观察召回质量（`recallMemoryForChat` 的命中率与人工抽查）
- [ ] 一周内无异常再删 legacy 写路径
- [ ] `memory-dual` 开关保留到删除 legacy 之后

## 六、复现方式

```bash
node scripts/dual-diff.mjs          # 摘要 + 前 20 条差异
node scripts/dual-diff.mjs --all    # 全部差异
```

两个实现坑（已在脚本里注释）：

1. `wrangler d1 execute --file` **只回统计信息，不回结果集** —— 必须用 `--command`
2. wrangler 先输出 ANSI 日志，`out.indexOf('[')` 会切进颜色码 —— 先剥掉 `\u001b\[…m`
