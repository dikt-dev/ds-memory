# 归档审计 2026-10-28

审计对象：2026-10-28 04:00 归档任务，目标日期 `2026-10-27`。

## 归档结果

```text
job_type=daily_archive
target=2026-10-27
status=done
归档 122 条消息
记忆 6478→6466 字节
提炼=true
提炼费用 ¥0.0394
去重=0
分层=0
裁剪=false
run_at=2026-10-28 04:01:30
```

## 消息完整性

D1：

```text
2026-10-27：122 条，ID 869–990
2026-10-28：37 条，ID 991–1027
```

R2：

```text
chat_logs/2026-10-27.log
122 条，ID 869–990
```

数量、首尾 ID 一致，没有丢消息。

角色分布：

```text
user 60
assistant 62
```

检查归档内容：

```text
[END] 0
历史时间标签 [10- 0
```

没有发现上一轮修复前的标记污染。

## 记忆源

R2 `memory.md`：

```text
6467 字节
作息：8:15出门，8:30上班，18:00下班
```

没有旧的 `上班8:15`、`差强人意`、`完成了：` 或 `[END]`。

## 发现的问题

归档后检查发现：

```text
memory_chunks：43
vec IS NULL：41
```

也就是说，重建上下文写入了新 chunks，但没有及时补向量，召回会退化成纯关键词。

### 原因

- 归档重建会重写 `memory_chunks`；
- 向量补齐依赖 `embed_chunks` 任务；
- 任务队列失败或未执行完时，没有兜底；
- 当天数据因此留下 41 条无向量 chunks。

### 已处理

1. 立即调用 embed，补齐 41 条；
2. 当前复查：

```text
chunks=43
no_vec=0
```

3. 在每日归档中加入兜底：

```text
runMemoryJobs 后强制检查并补 embedMemoryChunks
```

4. 队列不可用时，fallback 路径也会补 embedding。

## 关联与审计

```text
memory_links：87
same_entity：33
same_event：54
memory_audit：0（归档本身不写 audit，只有 /更正 等操作写）
```

## 摘要

月摘要、周摘要内容一致：

- 赛博搬家已完成
- QQ 机器人方案已放弃，改用自研 App
- 手机服务器/小米插座停用
- 语音已接入 Azure TTS，音色满意

没有回退到旧摘要。

## 结论

消息归档完整，记忆内容正确；发现并修复了 **归档后 chunks 向量缺失** 的问题。七天观察继续。

---

## 追加：10/26–10/27 记忆未进入 memory.md

### 现象

归档任务显示 `提炼=true`，但 `memory.md` 最新日期停在 10/25；D1 的 `memory_entries` 最大值也是 10/25。

### 根因

归档提炼实际生成了 10/26、10/27 摘要，保存在：

```text
context/2026-10-26.json → distilled_summary
context/2026-10-27.json → distilled_summary
```

但模型输出是**裸 bullet，没有 `## 分区` 标题**：

```text
- [26-10-26] ...
- [26-10-27] ...
```

`mergeMemoryEntry()` 只遍历 `dist.sections`，裸 bullet 留在 `dist.pre`，于是整段被静默丢掉。

`提炼=true` 的标记也不准确：它把情绪结算等变更算进了 `distilled`，不能代表“记忆文本已合并”。

### 修复

- `mergeMemoryEntry()` 增加裸 bullet 兜底：没有分区的 bullet 落到 `## 近期动态`；
- `normalizeBullets()` 修正关系行判断：先去掉 `-` 再识别“好感度/亲密度…”，避免关系行被当普通条目；
- 提炼提示词要求必须用 `## 分区名` 包裹，不要只输出裸 bullet；
- 新增一次性接口：

```text
POST /api/admin/memory/replay-distill
{ "dates": ["2026-10-26", "2026-10-27"] }
```

- replay 后会重新索引并补 embedding，避免 `no_vec`。

### 回填结果

```text
applied: 2026-10-26, 2026-10-27
memory.md: 6467 → 7889 字节
memory_entries: 53 条，最大日期 2026-10-27
memory_events: 10/26 4 条，10/27 8 条
chunks: 55，no_vec: 0
```

`memory.md` 现在包含 10/26 和 10/27 的条目；10/26/27 的内容暂时进入“近期动态”，后续会按分区规则整理。

### 回填后的最终状态（含分区整理）

```text
memory.md: 8022 字节
memory_entries: 73 条，最大日期 2026-10-27
memory_events: 35 条，最大日期 2026-10-27
memory_chunks: 55 条，no_vec: 0
```

10/26、10/27 的条目已从“近期动态”按内容移动到：

- 称呼与关系
- 关于用户
- 偏好与习惯
- 进行中的事项
- 共同经历

避免这些条目在“近期动态”7 天清理时再次消失。
