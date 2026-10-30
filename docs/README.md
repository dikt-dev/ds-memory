# 文档索引

整理于 2026-10-30。原 43 个文件平铺在 `docs/` 下，现按「现在要看的 / 当时发生了什么」分层。
历史内容一律保留原文，只做合并与移动，未改写结论。

## 先看哪个

| 你想知道 | 看这里 |
|---|---|
| 系统现在怎么样、卡在哪 | [current-state.md](./current-state.md) |
| **接下来做什么、什么时候做** | **[TASKS.md](./TASKS.md)**（唯一排期来源） |
| 某项任务的技术细节 | [pending-work.md](./pending-work.md)、[memory/memory-backlog.md](./memory/memory-backlog.md) |
| 整体架构怎么搭的 | [architecture.md](./architecture.md) |
| 某个功能具体怎么实现的、怎么排障 | [memory-system-walkthrough.md](./memory-system-walkthrough.md) |
| 从别人那接手 | [handover-2026-10-29.md](./handover-2026-10-29.md) |
| 为什么这么设计 | [design-notes.md](./design-notes.md)（早期文档，部分已被实现取代） |

## 根目录：高频，保持扁平

| 文件 | 内容 | 更新 |
|---|---|---|
| `current-state.md` | 当前状态快照：能力、指标、已知问题 | 10-29 |
| `TASKS.md` | **任务总表（唯一排期来源，每次改动需维护）** | 10-30 |
| `pending-work.md` | 待做事项的技术细节（排期以 TASKS.md 为准） | 10-30 |
| `architecture.md` | 模块、数据流、存储、部署 | 10-27 |
| `memory-system-walkthrough.md` | 实现级细节：阈值、降级矩阵、排障 | 10-27 |
| `design-notes.md` | 早期设计推演，与代码不一致处已标注 | 10-23 |
| `baseline.md` | Phase 0 基线：指标、测试、体积 | 10-27 |
| `handover-2026-10-29.md` | 交接文档（世界观 + 现状 + 坑） | 10-29 |

## plans/：计划类

| 文件 | 内容 |
|---|---|
| `refactor-master-plan.md` | 重构总纲：Phase 0–6 的目标与验收 |
| `refactor-execution-plan.md` | 执行拆解：每阶段任务、顺序、回滚点 |
| `post-observation-plan.md` | 观察期结束后的第一批动作 |
| `liveliness-plan.md` | 主动性/生命力设计 |
| `affect-policy.md` | 情感与态度策略规则 |
| `memory-regression-plan.md` | 记忆回归用例计划 |

## phases/：当时发生了什么

| 文件 | 内容 |
|---|---|
| `p0-p4-report.md` | Phase 0–4 五份报告合并（按时间顺序） |
| `phase-5/` | Phase 5 全套：cutover、进度、观察总则、Day 1–4 日报、终审 |

日报是最有价值的排障素材：每个问题都带「现象 → 定位 → 修法 → 结果」。

## memory/：记忆子系统专题

| 文件 | 内容 |
|---|---|
| `memory-backlog.md` | 尚未实施的记忆技术项 |
| `memory-project-comparison.md` | 与开源记忆项目对比（含已落地项） |
| `code-review-responses.md` | 10-28 与 10-29 两次代码评估的核对（含被推翻的结论） |
| `memory-rollback-plan.md` | 快照与回滚方案（§5.1 已实现） |
| `borrowed-from-dsh-fish.md` | 从 dsh-fish 借鉴清单及取舍理由 |
| `p1-batch-2026-11-01.md` | P1 批次改动说明 |

## video/：B 站视频链路

| 文件 | 内容 |
|---|---|
| `pipeline.md` | 抽帧方案 → 代码评审 → 官方摘要/字幕诊断（三份合并） |

## logs/：审计与问题记录

| 文件 | 内容 |
|---|---|
| `archive-audit-2026-10-28.md` | 归档审计与历史回填 |
| `issue-log-2026-10-30.md` | 问题流水（现象、定位、修法） |
| `p5-cleanup-manifest.md` | Phase 5 旧表/旧代码清理清单 |

## runbooks/ 与 eval/

| 文件 | 内容 |
|---|---|
| `runbooks/backup-rollback.md` | 备份与回滚操作手册 |
| `runbooks/deploy-2026-11-01.md` | 11-01 12:00 发布手册：前置检查、命令、验证、回滚 |
| `runbooks/operations-notes.md` | 日常运维零散笔记 |
| `eval/` | 评测夹具：`golden-memory.json`、`affect-scenarios.json`、`safety-cases.json`、`fixture-memory.md` |

## 最近一次核对（2026-10-30）

发布前把全部文档过了一遍，结果如下。

**检查项**

| 项 | 结果 |
|---|---|
| 相对链接 | 0 个坏链（扫描全部 .md） |
| 提交号引用 | 文档里引用的提交都能在 git 里找到 |
| 观察期时间 | 全库统一为 2026-11-01 **12:00**，无 21:10 残留 |
| 过期状态声明 | 修 1 处：视频链路的 Range/ETag **早已部署**（e7f6557e），文档还写「未部署」 |
| 过期数字 | 修 3 处：测试用例 722/699 → 765、提炼模型 v4-flash → v4-pro（带思考） |
| 过期日期头 | 修 2 处：`pending-work.md`、`memory-backlog.md` |

**权威顺序**（冲突时从上往下）

1. 代码与线上版本
2. `current-state.md` 第 0 节「现状速览」
3. `pending-work.md`（待办与时间点）
4. `handover-2026-10-29.md`（交接上下文）
5. 各专题文档；`baseline.md`、`phases/`、`logs/` 属历史记录，不改结论

**刻意保留的旧数字**

`plans/refactor-master-plan.md`、`baseline.md`、`phases/p0-p4-report.md` 里的「631 个测试」「45 个文件」
是当时的基线，**不要改成现在的数字**——它们是判断「重构有没有拖慢测试」的参照点。

## 约定

- **状态类文档只有一份**：`current-state.md` 与 `pending-work.md` 是唯一入口，阶段报告不重复维护状态。
- **历史文档不改结论**：发现过时，在文首加注「以代码为准」并指向新文档，不删原文。
- **合并保留来源**：合并文件内用 `<!-- merged from: xxx.md -->` 标注分段，可用 `git log --all -- docs/xxx.md` 追历史。
- **新增文档前先想**：能不能并进现有文件？只有「会长期独立演进」的才新建。