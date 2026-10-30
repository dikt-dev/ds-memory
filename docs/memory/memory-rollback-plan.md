# 记忆快照与回滚方案

> 状态：**§5.1 写前快照 + §5.4 清理已实现**（2026-10-30，未部署）；§5.2 恢复与 §5.3 接口排 11-02~11-04。
> 结论：**要做，但只做「每日快照 + 一条恢复接口」**，不做版本历史、不做自动回滚。

## 1. 为什么要做

`memory.md` 是长期记忆的唯一真相，每天 04:00 由归档任务覆盖写一次。一年 365 次。

现有保护只有写后校验（`putMemory` 读回比对），它能保证「写进去了、没被截断」，
**保证不了「写进去的是对的」**。提炼模型输出一条语义错误、日期错乱、把两件事混成一条的
记忆时，文件写得好好的，校验全部通过。

## 2. 现状：有备份，但漏了最频繁的那次

| 时机 | 位置 | 触发 |
|---|---|---|
| 重新归档并提炼 | `memory/backups/<时间戳>.md` | 手动 `/api/admin/rearchive-logs` |
| 记忆投影应用前 | `memory/backup/memory-<时间戳>.md` | 管理员操作 |
| 重置记忆前 | `memory/backup/reset-<时间戳>.md` | 手动 reset |

共同点：都是「人主动做危险操作」之前才备份。**每日归档写之前没有快照**，而它是唯一
每天都会发生的写入。

顺带一个历史包袱：`memory/backups/` 与 `memory/backup/` 两个前缀并存，是不同时期加的。
本方案统一用新前缀 `memory/snapshots/`，旧的不动（避免误删历史备份）。

## 3. 三个真实故障场景

1. **提炼跑偏**：模型把「用户说要辞职」提炼成「用户已离职」，写进「关于用户」。
   这条会被反复召回，而且很难发现——只能靠人翻 `memory.md` 时偶然看到。
2. **`/更正` 操作失误**：改错位置，删掉了相邻条目。
3. **Phase 6 格式变更**：新格式解析出错，写回时丢一段。没有快照就只能从 archive 重放，
   成本高且不精确。

三者共性：**diff 很小，影响是长期的**。

## 4. 目标与非目标

**目标**
- 每天归档写入前留一份快照，能在任意时刻回到某天开始时的记忆状态。
- 恢复操作本身可撤销（恢复前先备份当前）。
- 恢复后索引与 Memory Context 与 `memory.md` 一致。

**非目标**
- 逐条目版本历史 / 时间旅行（复杂度上一个量级，收益边际）。
- 自动回滚（「异常」没有可靠判据，误回滚比不回滚更糟）。
- 恢复后保留当日新增条目（做不干净，不如整份恢复）。

## 5. 设计

### 5.1 快照：写前、按日期、只写一次

位置：`runDailyArchive` 里 `putMemory(env, memory)` 之前。

```ts
// target = 本次归档的日期键（YYYY-MM-DD）
const snapKey = `memory/snapshots/${target}.md`;
const exists = await headObject(env, snapKey);
if (exists === null) {
  await putObject(env, snapKey, memory, { contentType: 'text/markdown' });
}
```

三个刻意的选择：

- **只写一次**：同一天重跑归档不覆盖。要的是「当天开始时的状态」，重跑一百次也该只有一份。
- **写在 putMemory 之前**：快照的内容必须是「本日写入前的记忆」，不是写坏的版本。
- **失败不阻断归档**：`try/catch` 包住，快照写失败只记日志，不影响当天提炼。

保留期：45 天。每天约 12KB，45 天约 540KB，R2 上可忽略。

### 5.2 恢复：三步，缺一步就会不一致

```ts
// 1) 先把当前状态备份成可撤销点
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const pre = `memory/backup/pre-restore-${stamp}.md`;
await putObject(env, pre, await getMemory(env), { contentType: 'text/markdown' });

// 2) 写回快照内容（走 putMemory 的读回校验）
const ok = await putMemory(env, snapshotText);
if (!ok) throw new Error('恢复写入校验失败，未改动索引');

// 3) 重建派生层：只改 R2 不改索引 = 召回继续返回已回滚的内容
await reindexMemory(env);
await replaceMemoryContext(env, snapshotText, 'memory');
```

第 3 步最容易漏。`putMemory` 的校验只管 R2，D1 里还留着旧记忆，召回会继续命中已被回滚掉的条目。

**顺序不能反**：先备份 → 再写 → 再重建。重建失败时 R2 已经是新内容、索引是旧的，
这时应报错并提示「重跑 /api/admin/memory/reindex」，而不是自动重试整个恢复。

### 5.3 接口

```
GET  /api/admin/memory/snapshots
     → { days: [{ date, bytes }] }，走 listKeys('memory/snapshots/')

POST /api/admin/memory/restore
     body: { date: 'YYYY-MM-DD', confirm: true }
     → { ok, restoredFrom, preRestoreBackup, bytes, facts, chunks }

未来可加（Phase 6）
GET  /api/admin/memory/diff?date=YYYY-MM-DD
     → 该日快照与当前记忆的条目级差异（新增/删除/修改）
```

`confirm: true` 是硬性要求：恢复是破坏性操作，不能靠 UI 的弹窗保证。

### 5.4 清理

在每日归档里顺手做，超期快照删除：

```ts
const keys = await listKeys(env, 'memory/snapshots/');
// 保留最近 45 个（按 key 里的日期排序），其余 deleteObject
```

## 6. 并发与边界

| 场景 | 处理 |
|---|---|
| 恢复时正好在跑每日归档 | 两边都写 `memory.md` → 后写的赢。加 KV 写锁 `memory:lock:write`（TTL 120s），拿不到锁就返回 409 |
| 快照不存在（该日期早于本功能上线） | 404，并在响应里说明「快照从 <首日> 起可用」 |
| 恢复后 `memory_rollups` 仍是旧摘要 | 已知边界：摘要按周/月生成，恢复不回溯。文档写明，不自动重建 |
| 恢复内容为空或解析失败 | 写前校验：`parseMemoryContext` 至少要能解析出 1 条事实，否则拒绝 |

## 7. 测试计划

用 `memory.test.ts` 同款 fake Env（已实现 KV/R2 替身），新增：

1. 快照已存在时**不覆盖**（同一天重跑只留第一份）
2. 快照写失败时归档继续（返回 ok，日志有告警）
3. 恢复前一定先写了 `pre-restore-*`
4. 恢复后调用了 `reindexMemory` 与 `replaceMemoryContext`（用 spy 断言调用次数）
5. 超期快照被清理，未超期的保留
6. `confirm` 不为 true 时返回 400

## 8. 排期

| 阶段 | 内容 | 风险 |
|---|---|---|
| 11-01 解冻后（与第一批同批） | 5.1 写前快照 + 5.4 清理（纯增量，只多写一个对象） | 极低 |
| 11-02 ~ 11-04 | 5.2 恢复逻辑 + 5.3 两个接口 + 写锁 | 中（破坏性能力） |
| Phase 6 | `diff` 接口或脚本 | 低 |

## 9. 验收标准

- 连续跑 3 天归档后，`memory/snapshots/` 下正好 3 个文件，且内容与当天归档前的 `memory.md` 字节一致。
- 同一天手动重跑归档，快照文件 mtime 不变。
- 恢复一个 3 天前的快照后：`memory.md` 字节数 = 快照字节数；`memory_entries` 行数与重新 `reindex` 结果一致；`memory-chunks` 里不再出现该日期之后的条目。
- 恢复再恢复回去（用 `pre-restore-*`），内容能回到恢复前。

## 10. 本方案自身的开关

如果快照逻辑出问题，只需要改一行：把 `runDailyArchive` 里的快照块整段删掉或包在
`if (env.MEMORY_SNAPSHOT !== 'off')` 后面（默认开启）。恢复接口可以直接不挂路由。
两者都不影响现有归档与召回。

---

## 附：为什么不是「事件溯源」

同期看过的 `dsh-fish` 用只追加的 `events.jsonl` 做真相源，天然可回放，不需要快照。
我们不采用：那个模型里**用户不能改记忆**，而我们要支持 `/更正`——一旦允许改写，
「只追加」就不成立了，回滚必须靠独立副本。两条路各有代价，我们这条代价更低。