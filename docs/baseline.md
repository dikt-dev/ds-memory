# Phase 0 基线记录

> 日期：2026-10-24  
> 基线提交：`9155038`（`pre-refactor` tag）  
> 环境：Windows / Node v24.21.0 / pnpm 依赖已安装  
> 用途：Phase 0–5 的对照基线；每次 Phase 门禁更新一次

---

## 1. 构建与测试

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `node node_modules/typescript/bin/tsc --noEmit` | ✅ 0 error |
| 单测（Phase 0 前） | `node node_modules/vitest/vitest.mjs run` | ✅ 45 files / 631 tests |
| 单测（Phase 0 后） | `bash scripts/verify.sh` | ✅ 46 files / 637 tests |
| 单测（Phase 1 后） | `bash scripts/verify.sh` | ✅ 47 files / 645 tests |
| 单测（Phase 2A 后） | `bash scripts/verify.sh` | ✅ 48 files / 653 tests |
| 单测（Phase 2B 后） | `bash scripts/verify.sh` | ✅ 50 files / 659 tests |
| 验证脚本 | `bash scripts/verify.sh` | ✅ tsc + vitest |

> 注意：在当前 DSH 沙箱内，Vitest/Vite 需要启动子进程；若沙箱为 workspace-write 可能报 `spawn EPERM`。这不是代码失败。基线记录来自完整权限执行。

---

## 2. 代码规模与结构

| 项 | 值 |
|---|---|
| `src/*.ts` | 约 50 个模块 |
| 测试文件 | 45（Phase 0 前）→ 46（trace）→ 47（Phase 1 auth/runtime） |
| 测试用例 | 631（Phase 0 前）→ 637（trace）→ 645（Phase 1） |
| 入口 | `src/index.ts` |
| 前端 | `public/index.html` |
| 数据库 schema | `schema.sql` |
| 归档/任务 | `src/jobs.ts` |
| 记忆索引 | `src/memory-index.ts` |
| 关系/情绪 | `src/relation-*.ts`、`src/emotion-*.ts` |

---

## 3. 当前 KV 估算（Phase 0 基线）

免费额度：读 100,000/天、写 1,000/天、删 1,000/天。

| 来源 | 估算 |
|---|---|
| 网页轮询鉴权（3s，1 标签页 24h） | 约 28,800 读 |
| 每轮聊天 KV 读（memory/memo/weather/persona 等） | 约 8~12 读/轮 |
| 手机心跳 | 288 写/天 |
| 情绪状态 | 约 1 写/轮 |
| query 向量缓存 | 约 1 写/新 query |
| profile dirty（60s 节流） | 50~500 写/天 |
| summary/memo 锁 + 内容 + 成本 | 20~50 写/天 |
| weather | 约 48 写/天 |

**结论**：写额度比读额度更容易先撞顶；网页轮询鉴权是读额度的最大单点。

---

## 4. 当前记忆/关系行为基线

- 短期：10 轮（`turn_id` 分组，按 `created_ms/id` 升序，带 `[MM-DD HH:mm]`）。
- 长期：`memory.md` ≤16KB 全量注入；更大时核心+稳定画像+召回。
- 中期：`memo:24h`，3h 或 15 条消息刷新。
- 摘要：首次 20 条，之后新增 10 条或 1 小时。
- 关系：5 轴整数存 `memory.md`；情绪状态存 KV；态度每轮派生。
- 归档：04:00 归档前一天；失败可补跑；D1 只保留今天/昨天。
- 索引：`memory_entries`，关键词 + `bge-m3` 向量；每日重建。

---

## 5. 基线评估集

Phase 0 新增：

- `docs/eval/golden-memory.json`
- `docs/eval/affect-scenarios.json`
- `docs/eval/safety-cases.json`
- `docs/eval/README.md`

当前只记录基线，评分在 Phase 2/3/4 接入自动/人工评估。基线分数待第一次回放后补录。

---

## 6. 已知限制

- 没有自动化的 API 端到端测试；契约测试以纯函数/路由解析为主。
- 没有持久化 trace；Phase 0 使用结构化日志 + request-id。
- 没有历史对话回放 harness；Phase 2/4 补。
- 线上数据仅用于只读基线，不写入、不删除。

---

## 7. 线上只读基线（2026-10-24）

只读操作，未写入/删除任何线上数据：

| 项 | 值 |
|---|---:|
| D1 `messages` | 594 行 |
| D1 `memory_entries` | 34 行 |
| D1 `cron_runs` | 2 行 |
| D1 `proactive_queue` | 3 行 |
| R2 `memory.md` | 6,491 字节 |
| D1 查询 rows_read | 633（本次计数查询） |

本地备份：`backup/r2/memory.md`（`backup/` 已在 `.gitignore`，不会提交）。

> 计数只是 Phase 0 基线，后续阶段不得用这些数字做业务判断；以实际查询时间为准。

---

## 8. 变更记录

| 日期 | 版本 | 说明 |
|---|---|---|
| 2026-10-24 | v0.1 | Phase 0 基线 |
