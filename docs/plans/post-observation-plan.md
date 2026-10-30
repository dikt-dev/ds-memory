# 七天观察结束后的执行方案

更新：2026-10-29

观察窗口：

```text
2026-10-25 21:10 → 2026-11-01 12:00（Asia/Shanghai）
```

适用对象：ds-memory Phase 5 观察期结束后的验收、决策和切换。

---

## 0. 总原则

```text
先验收 → 再决策 → 再逐通道切换 → 再做后续记忆改造
```

不要：

- 观察刚结束就同时切 memory/affect；
- 同时切 App 和 Web；
- 在没有备份/回滚方案时切 `next`；
- 把“没报错”当成“记忆质量合格”。

---

## 1. 时间线

### 2026-11-01 04:00

自动执行：

```text
daily_archive(2026-10-31)
monthly_merge(2026-10)
```

04:05 后检查：

- `cron_runs` 状态；
- 月文件 `chat_logs/2026-10.json`；
- 日文件是否按预期删除；
- D1 旧数据清理；
- `hasArchivedDate` 能否从月文件识别 10 月日期；
- `memory_chunks no_vec=0`；
- 归档消息数与 D1 对账。

### 2026-11-01 12:00

观察期结束，冻结：

- 不再改 prompt/记忆/flag；
- 生成最终快照；
- 保存 metrics、usage、归档状态。

### 2026-11-02

出最终观察报告：

```text
docs/phases/phase-5/phase-5-final-review.md
```

内容包括：

- shadow vs legacy 指标；
- 记忆质量；
- 错误/P0；
- 成本/延迟；
- 归档/月度合并；
- App 稳定性；
- 是否允许切换。

### 2026-11-02 至 11-03

按决策逐通道切换：

- 手机 memory；
- 手机 affect；
- Web memory；
- Web affect；
- 主动消息单独评估。

每个通道至少观察 24 小时，不同时切。

---

## 2. 验收门槛

### 必须满足（P0）

```text
无消息丢失
无重复发送复发
无归档数据丢失
月度合并成功
no_vec=0
readiness=true
无未处理的 P0
```

### 记忆质量

使用 `scripts/memory-regression.mjs` + 固定样本：

```text
同事件命中率 >= 80%
同实体命中率 >= 80%
无关样本噪声率 <= 20%
平均 linked_items <= 2
```

### 稳定性

```text
连续 7 天无 P0
错误率不高于 legacy
首字延迟增量 <= 150ms
单轮成本增量在预算内
```

### 用户体感

至少确认：

- 回复没有明显记忆错乱；
- 称呼/边界没有被旧记忆污染；
- 静默结束/时间标签/文件卡片正常；
- 没有“越聊越卡/越聊越重复”。

---

## 3. 决策矩阵

### A. 全部通过

```text
允许进入 next 灰度
```

顺序：

```text
1. MEMORY_ENGINE_MOBILE=next
2. 观察 24h
3. AFFECT_ENGINE_MOBILE=next
4. 观察 24h
5. MEMORY_ENGINE_WEB=next
6. 观察 24h
7. AFFECT_ENGINE_WEB=next
```

主动消息继续：

```text
PROACTIVE_ENGINE=shadow
PROACTIVE_DELIVERY=queue
```

等独立复核后再切。

### B. 部分通过

例如记忆召回好，但错误率/延迟不达标：

```text
保持 shadow/legacy
只修具体问题
不进 next
```

不要用“先切了再修”赌稳定性。

### C. 不通过

```text
保持 legacy
回滚本轮改动
保留数据和审计
重新排期
```

---

## 4. 切换前备份

切换前必须做：

```text
1. R2 memory.md 备份
2. R2 chat_logs 关键日期备份
3. D1 导出 messages/memory_* 表
4. 记录当前 flag
5. 记录回滚命令
```

建议备份路径：

```text
backups/pre-next-20261102/
```

不提交任何真实数据到 git。

---

## 5. 逐通道切换方法

### 第一步：手机 memory

只改：

```text
MEMORY_ENGINE_MOBILE=next
```

保持：

```text
AFFECT_ENGINE_MOBILE=shadow
MEMORY_ENGINE_WEB=legacy
AFFECT_ENGINE_WEB=legacy
```

观察 24h：

- 首字延迟；
- 记忆召回是否答偏；
- 错误率；
- 用户体感。

### 第二步：手机 affect

```text
AFFECT_ENGINE_MOBILE=next
```

观察 24h：

- 情绪是否过度波动；
- 关系数值是否异常；
- 回复是否变得不像原来的人。

### 第三步：Web

按同样顺序：

```text
MEMORY_ENGINE_WEB=next
→ 24h
→ AFFECT_ENGINE_WEB=next
```

Web 和 App 不同时切，便于定位问题。

---

## 6. 切换后监控

每天：

```text
readiness
engine_metrics
错误率
首字延迟
单轮成本
no_vec
归档状态
用户主观反馈
```

出现以下任一情况立即回滚：

```text
P0 消息丢失/重复
记忆明显错乱
错误率显著高于 legacy
延迟明显变慢
用户明确说“变笨/变奇怪”
```

回滚：

```text
MEMORY_ENGINE_MOBILE=shadow
AFFECT_ENGINE_MOBILE=shadow
MEMORY_ENGINE_WEB=legacy
AFFECT_ENGINE_WEB=legacy
```

回滚只改 flag，不删数据。

---

## 7. 月度合并失败怎么处理

如果 11/01 `monthly_merge` 失败：

1. 不删除 D1，不删除日文件；
2. 看 `cron_runs` detail；
3. 检查是否仍有缺失日期；
4. 检查跨天重复冲突；
5. 修复后重新跑月度合并；
6. 月文件写后回读校验通过，才允许删日文件；
7. 未通过前保持 `MEMORY_ENGINE_*` 不变。

---

## 8. 观察结束后的记忆改造顺序

验收通过后，不要立刻做所有 backlog。

建议：

```text
1. 自动回归每日执行 / 样本扩到 20 条
2. 跨日期近重复事实合并
3. 线索触发冷召回 + 逻辑索引
4. 事件向量冷召回
5. FTS/CJK 兜底
6. 静默结束后的主动消息暂停
7. 记忆查看/编辑 UI
8. BaiShou-Next 补齐
```

理由：

- 前两项直接影响记忆质量；
- 冷召回/逻辑索引需要回归样本；
- UI 是产品迭代，放后面；
- 主动消息暂停独立，避免和记忆切换混在一起。

---

## 9. 最终交付物

观察结束后应产出：

```text
docs/phases/phase-5/phase-5-final-review.md
```

包含：

- 七天指标汇总；
- 与 legacy 对比；
- P0/P1 清单；
- 归档/月合并结果；
- 成本/延迟；
- 是否切换；
- 切换后的 24h 观察记录；
- 回滚记录（如有）。

---

## 10. 一句话结论

```text
11/01 04:00 先验月合并；
11/01 12:00 冻结并出报告；
11/02 起单通道灰度；
每个通道 24h；
不达标就保持 shadow/legacy，不赌。
```
