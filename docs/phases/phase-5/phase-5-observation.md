# Phase 5 观察手册（7 天 / 2 周）

> 目标：给 `refactor-p5` 提供可复核的每日快照，而不是凭记忆判断。

## 每日快照

```bash
cd ds-memory
node scripts/p5-observe.mjs
```

输出：

```text
backup/p5-observation/YYYY-MM-DD.json
```

内容：

- `/api/health`
- `/api/admin/readiness`
- `/api/admin/engine-metrics?days=7`
- `/api/admin/storage-check`（小号 R2 put/get/delete + 主模式回源）

`backup/` 已在 `.gitignore`，快照不会进仓库。

## 7 天 App shadow 通过条件

> 观察起点：2026-10-25 21:10（Asia/Shanghai）；今日测试消息/验证情绪/指标已清空。
> 当前入口为 DS-Mobile，旧的 QQ shadow 阶段不再作为主验收数据。

- `readiness.ready=true`；`memory_engine_mobile=shadow`、`affect_engine_mobile=shadow`；
- `readiness.proactive_engine` 当前应为 `shadow`；确认 `engine_metrics.channel='mobile'` 出现 memory/affect 行；
- `engine_metrics` 里 `kind=memory` 有稳定请求量，`new_bytes` 不为 0；
- 无 5xx / 超时 / `memory.engine.error`；
- `old_items`/`old_bytes` 允许为 0（说明本轮 legacy 召回本身为空，不是新引擎失败）；
- App `heartbeat_age_seconds < 180`，通道在线；
- 用户没有反馈“记错/重复/答非所问”。

## 7 天 App next 通过条件

- 回复不再出现空召回、重复记忆、越界关系数值；
- `attitude-v1` 不出现数值泄露、真实意识宣称、愧疚施压；
- 错误率/首字延迟/费用与 shadow 期相比无明显上升；
- 回滚演练仍可执行：`next → legacy` 后 `record=false` 200。

## 每日问题记录

- [Day 1：2026-10-26](phase-5-observation-day1.md)（已封板）
- [Day 2：2026-10-27](phase-5-observation-day2.md)

## 2 周门禁

- App 为 `next`，网页保持 legacy 或单独切；主动消息接新引擎；
- 连续 2 周无 P0；
- `readiness` 全绿；D1/R2 在免费额度；
- 回滚演练通过；
- 旧表/旧代码按 `docs/logs/p5-cleanup-manifest.md` 清理（先备份）。

全部通过后再：

```text
git tag refactor-p5
```

Phase 6 单独开始。
