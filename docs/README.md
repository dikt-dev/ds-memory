# 文档索引

整理于 2026-11-09。上一版是 10-30 的 43 文件平铺版；这一版把 11 月新增的 `design/`、`memory-redesign.md`、`HANDOFF.md` 等补进索引，并把已被取代的「现状/交接/审查」类文档移进 `archive/`。**只移动与改链，未改写任何结论。**

## 先看哪个

| 你想知道 | 看这里 |
|---|---|
| 系统现在怎么样、卡在哪 | [current-state.md](./current-state.md) |
| **接下来做什么、什么时候做** | **[TASKS.md](./TASKS.md)**（唯一排期来源） |
| 从别人那接手 | [HANDOFF.md](./HANDOFF.md)（最新，顶部有「11-09 增量」） |
| 记忆系统要往哪改 | [memory-redesign.md](./memory-redesign.md)（当前主线方案） |
| 某项任务的技术细节 | [pending-work.md](./pending-work.md)、[memory/memory-backlog.md](./memory/memory-backlog.md) |
| 整体架构怎么搭的 | [architecture.md](./architecture.md) |
| 某个功能具体怎么实现的、怎么排障 | [memory-system-walkthrough.md](./memory-system-walkthrough.md) |
| memory.md 该扮演什么角色 | [MEMORY-MD-ROLE.md](./MEMORY-MD-ROLE.md) |
| 为什么这么设计（早期推演） | [design-notes.md](./design-notes.md)（部分已被实现取代） |

## 根目录：高频，保持扁平

| 文件 | 内容 |
|---|---|
| `current-state.md` | 当前状态快照：能力、指标、已知问题 |
| `TASKS.md` | **任务总表（唯一排期来源，每次改动需维护）** |
| `HANDOFF.md` | 交接待办：环境、坑、未提交物、近期改动 |
| `pending-work.md` | 待做事项的技术细节（排期以 TASKS.md 为准） |
| `memory-redesign.md` | 记忆系统重构方案（免费额度版） |
| `MEMORY-MD-ROLE.md` | memory.md 四种定位的利弊 |
| `AUTONOMY-PLAN.md` | 自主记忆改造的执行清单与六条不变量 |
| `architecture.md` | 模块、数据流、存储、部署 |
| `memory-system-walkthrough.md` | 实现级细节：阈值、降级矩阵、排障 |
| `design-notes.md` | 早期设计推演，与代码不一致处已标注 |

## design/：功能设计稿

`activity-pool.md`（活动池，**被 `scripts/gen-pool.mjs` 读作生成源**）、`ai-life-system.md`、`anime-catalog.md`、`background-keepalive.md`、`friends-plan.md`、`friends-template.md`、`life-build-plan.md`、`persona-draft.md`、`persona-template.md`、`proactive-notify.md`、`prompt-memory-redesign.md`、`send-flow.md`、`TODO.md`、`video-perception.md`、`voice-tts.md`、`web-ui.md`（「纸墨」视觉令牌与版面规则）、`screenshots/`（网页端 5 张验收图）。

## memory/：记忆子系统专题

`memory-backlog.md`、`memory-architecture-v2.md`、`memory-milestones.md`、`memory-rollback-plan.md`、`memory-project-comparison.md`、`code-review-responses.md`、`keepsake-implementation.md`、`borrowed-from-dsh-fish.md`、`dual-index-diff-2026-11-01.md`、`p1-batch-2026-11-01.md`。

## plans/ · phases/ · logs/：计划与历史

- `plans/`：`refactor-master-plan.md`（重构总纲）、`refactor-execution-plan.md`、`post-observation-plan.md`、`liveliness-plan.md`、`affect-policy.md`、`memory-regression-plan.md`
- `phases/`：`p0-p4-report.md`（五份报告合并）、`phase-5/`（cutover、进度、观察总则、Day 1–4 日报、终审）
- `logs/`：`archive-audit-2026-10-28.md`、`issue-log-2026-10-30.md`、`p5-cleanup-manifest.md`

历史文档不改结论；发现过时就加注指向新文档。

## runbooks/ · video/ · eval/

- `runbooks/`：`backup-rollback.md`、`deploy-2026-11-01.md`、`local-env.md`、`operations-notes.md`
- `video/`：`pipeline.md`、`understanding-eval.md`
- `eval/`：评测夹具与跑批结果。**`fixture-memory.md` 与 `golden-memory.json` 被 `src/memory-eval.test.ts` 直接 import，不要移动或改名。**

## archive/：当时发生了什么（已归档，勿再更新）

| 文件 | 原位置 | 归档理由 |
|---|---|---|
| `state/STATUS-2026-10-31.md` | 根目录 `STATUS.md` | 与 `current-state.md` 重复的「单页现状」，全库 0 处引用 |
| `state/baseline.md` | 根目录 | Phase 0 基线（10-24），历史参照，数字不要改 |
| `handoffs/handover-2026-10-29.md` | 根目录 | 已被 `HANDOFF.md`（11-03）取代 |
| `reviews/review-2026-10-31.md` | 根目录 | 一次性代码结构审查报告 |

## 权威顺序（冲突时从上往下）

1. 代码与线上版本
2. `current-state.md` 第 0 节「现状速览」
3. `TASKS.md`（排期）
4. `pending-work.md` / `memory-redesign.md`
5. `HANDOFF.md`（交接上下文）
6. 各专题文档；`archive/`、`phases/`、`logs/`、`baseline.md` 属历史记录，不改结论

**刻意保留的旧数字**：`plans/refactor-master-plan.md`、`archive/state/baseline.md`、`phases/p0-p4-report.md` 里的「631 个测试 / 45 个文件」是当时的基线，不要改成现在的数字。

## 约定

- **状态类文档只有一份**：`current-state.md` 与 `pending-work.md` 是唯一入口，阶段报告不重复维护状态。
- **历史文档不改结论**：发现过时，在文首加注「以代码为准」并指向新文档，不删原文。
- **新增文档前先想**：能不能并进现有文件？只有「会长期独立演进」的才新建。
- **链接检查**：改完跑 `node scripts/check-doc-links.mjs docs`（仓库根目录执行），目标 0 坏链。
