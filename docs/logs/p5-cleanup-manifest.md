# Phase 5 清理清单（先不执行）

> 状态：**等待 2 周稳定门禁**；本文只登记候选，不代表已删除。
> 最早执行时间：2026-11-07（QQ/网页 next 均稳定后）。

## 原则

1. 先备份：`backup/pre-p5/d1.sql` + `backup/pre-p5/memory.md`；
2. 先切 `next` 并观察，不边切边删；
3. 删除前确认无读路径引用；
4. 每一步可回滚（保留 R2 对象、D1 表至少 7 天）。

## D1 候选

| 对象 | 当前用途 | 删除前验证 |
|---|---|---|
| `memory_entries` | legacy 关键词/向量召回 | `MEMORY_ENGINE=next` 连续 7 天无 legacy 读 |
| `memory_entries_fts`（如有） | legacy 全文索引 | 同上 |
| 旧 `cron_runs` 历史 | 审计 | 保留最近 90 天，不删表 |
| 旧 `usage_events` | 计费 | 保留，按保留策略归档 |

> `messages`、`usage_events`、`proactive_queue`、`proactive_log` 是现行表，不在此列。

## KV 候选

| 键 | 当前用途 | 删除前验证 |
|---|---|---|
| `session:*` | `AUTH_MODE=kv` 旧会话 | 确认不再需要 kv 回滚，且所有客户端已重登 |
| `memory` / `memo:24h` | 旧缓存 | 确认新读路径不再回源 |
| `storage:mode` / `storage:usage` | 存储切换 | **保留**，现行 |

## 代码候选

| 文件/路径 | 说明 |
|---|---|
| `src/memory-index.ts` | legacy 索引；next 稳定后评估 |
| `src/memory-archive.ts` | 旧档案检索；next 稳定后评估 |
| `src/emotion-*.ts` 旧快照分支 | 仅 legacy 使用；next 稳定后评估 |
| `src/index.ts` 旧 `/api/*` 兼容路由 | 按客户端实际使用保留 |

## 验收

```text
readiness ready=true
MEMORY_ENGINE_QQ/WEB=next
AFFECT_ENGINE_QQ/WEB=next
engine_metrics 连续 7 天无 error/超时
D1/R2 用量下降
回滚：next → legacy 仍可 200
```

未满足前，不执行任何 DROP/DELETE。
