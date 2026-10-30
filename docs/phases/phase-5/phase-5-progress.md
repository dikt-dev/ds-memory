# Phase 5 进度报告：生产切换与 QQ shadow

> 日期：2026-10-24  
> 状态：🚧 进行中（**生产已迁移/部署；回滚演练通过；QQ shadow 观察中；7 天/2 周门禁未完成**）  
> runbook：[phase-5-cutover.md](ds-memory/docs/phases/phase-5/phase-5-cutover.md)

---

## 0. 生产执行记录

### 0.1 备份

```text
backup/pre-p5/d1.sql          784,476 bytes
backup/pre-p5/memory.md         6,491 bytes
```

### 0.2 迁移

003 → 007 已依次执行；只读校验 10 张新表全部存在：

```text
runtime_state, auth_revocations,
memory_facts, memory_events, memory_summaries, memory_chunks, memory_jobs,
affect_events, attitude_snapshots, engine_metrics
```

### 0.3 部署

- `AUTH_SECRET` 已写入生产（不落 repo/文档）；
- Worker 已部署，默认 `MEMORY_ENGINE=legacy` / `AFFECT_ENGINE=legacy`；
- 生产 `GET /api/health` 200；
- `GET /api/admin/readiness` 200：`ready=true`、`missing=[]`。

### 0.4 Memory Context 回填

```text
POST /api/admin/memory/rebuild-context → facts=21 events=13 chunks=34
POST /api/admin/memory/sync-summaries  → summaries=2
POST /api/admin/memory/extract         → ok
POST /api/admin/memory/embed           → embedded=38
context-stats → facts=23 events=13 summaries=2 chunks=38 embedded=38
```

`backfill-provenance` 首次 500：
`D1_ERROR: LIKE or GLOB pattern too complex`。  
已改为 `instr(content, ?) > 0`，重新部署后返回 200（本次 linked=0，已有部分来源保留）。

### 0.5 QQ shadow

生产变量：

```text
MEMORY_ENGINE_QQ=shadow
AFFECT_ENGINE_QQ=shadow
MEMORY_ENGINE_WEB=legacy
AFFECT_ENGINE_WEB=legacy
```

手机客户端已重新拉起：

```text
python3 main.py        运行中
NapCat                 已连接 QQ 2219827501
22:59 连接就绪
```

`record=false` 测试请求（不落聊天记录）：

```text
POST /v1/chat/completions → 200
memory shadow: 2 requests, new_bytes=1949, avg_ms=287
affect shadow: 3 requests, new_bytes=585, avg_ms=0
```

---

## 1. 预检代码/文档

---

## 1. 已完成（预检代码/文档）

### 1.1 渠道级开关

新增 [engine-flags.ts](ds-memory/src/engine-flags.ts)：

- `MEMORY_ENGINE_QQ` / `MEMORY_ENGINE_WEB`；
- `AFFECT_ENGINE_QQ` / `AFFECT_ENGINE_WEB`；
- 未设置时回退全局，再回退 `legacy`；
- QQ 与网页可以分别 shadow/next，满足 QQ 先行。

已接入：

- 网页 `chat.ts`（`channel=web`）；
- QQ `openai.ts`（`channel=astrobot`）；
- `wrangler.toml` 默认全部 legacy。

### 1.2 只读 readiness

新增 `GET /api/admin/readiness`（requireAuth）：

- 检查 10 张新表是否存在；
- 检查 `AUTH_SECRET`/migration/engine flags；
- 返回 memory bytes、context 统计、job 统计、warnings；
- 全绿返回 200，缺表返回 503；
- **不做任何写入**。

本地验证：

```text
200 {"ready":true,"missing":[],"auth_secret":true,
     "memory_engine":"legacy","affect_engine":"legacy",
     "context":{"facts":7,"events":5,"summaries":1,"chunks":13,"embedded":0},
     "warnings":["MEMORY_ENGINE=legacy","AFFECT_ENGINE=legacy","memory_chunks 尚无向量"]}
```

### 1.3 远程只读预检

对生产 D1 执行只读 `sqlite_master` 查询：

```text
runtime_state / auth_revocations / memory_* / memory_jobs / affect_* / attitude_snapshots
→ 0 张存在
```

结论：生产仍是旧 schema；迁移 003–006 尚未执行。  
未执行任何线上写操作。

### 1.4 QQ 契约

`ds-qq-client` 仍发送：

```json
{"inject_history": true}
```

协议未变，无需改客户端即可先 shadow/next。

---

## 2. 验证

```text
tsc --noEmit     ✅
vitest run       57 files / 695 tests ✅
scripts/verify.sh ✅ exit 0
```

新增 `engine-flags.test.ts`：

- 默认 legacy；
- QQ/WEB 覆盖独立；
- 渠道未设置回退全局。

---

### 1.5 QQ 客户端现状（手机 SSH 只读检查）

- 手机 SSH 可达；Termux 实际登录用户与配置脚本里的用户名不同，以 `whoami` 为准；
- `ds.sh status`：**client 未运行，NapCat 未运行**，6700/8080/6099 均未监听；
- 最近 client.log：
  - 19:54 Worker 健康检查 ok；
  - 20:03 正常回复；
  - 20:04 上传约 6MB 图片时 `SSL: SSLV3_ALERT_BAD_RECORD_MAC`，之后进程停止；
- 电量约 43%，未充电，插头 off；`plug-guard` 建议保持，未自动充电。

QQ 客户端单测（本地）：

```text
test_worker.py          16 passed
test_proactive_ack.py    4 passed
test_record_flag.py      5 passed
```

结论：契约未变；当前卡在手机客户端运行状态/TLS 上传，不是 Worker 协议变更。

### 1.65 指标聚合（新增）

- `engine_metrics`（迁移 007）；
- `recordEngineMetric`：只记录 shadow/next 的 requests/old/new/bytes/ms；
- `GET /api/admin/engine-metrics?days=7`；
- 不记录 query/回复正文；legacy 不写。

### 1.6 生产打包预检

```text
wrangler deploy --dry-run
→ Total Upload: 741.40 KiB / gzip: 179.93 KiB
→ bindings 正常
→ 未部署
```

---

### 1.7 回滚演练（2026-10-24）

```text
部署 QQ legacy（Version 55acda14）
→ readiness: qq=legacy, affect_qq=legacy, web=legacy
→ POST /v1/chat/completions record=false: 200

部署 QQ shadow（Version 246fb099）
→ readiness: qq=shadow, affect_qq=shadow, web=legacy
→ POST /v1/chat/completions record=false: 200
```

结论：`MEMORY_ENGINE_QQ` / `AFFECT_ENGINE_QQ` 的 legacy/shadow 回滚开关可用，
切换过程中 Worker 健康与 QQ 请求均正常。当前已恢复 QQ shadow。

---

### 1.8 每日观察快照

新增 `scripts/p5-observe.mjs` / `pnpm observe:p5`：

```text
health=200 readiness=200 metrics=200 storage=200
{"ready":true,"qq":"shadow","web":"legacy","facts":23,"chunks":38}
```

快照写入 `backup/p5-observation/YYYY-MM-DD.json`，包含 readiness、7 天指标、
小号 R2 put/get/delete + 回源结果，作为 7 天/2 周门禁的逐日证据。

---

### 1.9 主动消息新引擎（代码就绪，默认 legacy）

新增 `PROACTIVE_ENGINE=legacy|shadow|next`：

- `shadow`：计算新 Memory Context + attitude policy，只记录 `engine_metrics(kind=proactive)`；
- `next`：用新检索结果替换 `recalled`，用 `buildAttitudePolicy().text` 替换旧快照；
- 默认 `legacy`，线上行为不变；
- `readiness` 增加 `proactive_engine` 字段。

当前生产：

```text
proactive_engine=shadow（Version b7a8cb71）
```

shadow 只计算新上下文和态度策略并写 `engine_metrics(kind=proactive)`，
发出的内容仍走 legacy。等 QQ/网页 next 稳定后再切 `next`。

---

## 3. 未执行（观察/门禁）

| 项 | 状态 | 说明 |
|---|---|---|
| 远程迁移 003–007 | ✅ | 已执行并校验 10 表 |
| `AUTH_SECRET` 生产设置 | ✅ | 已写入，不回显 |
| Worker 部署 | ✅ | 默认 legacy；当前版本 QQ shadow |
| QQ shadow 7 天 | ⏳ | 已开始，需持续观察 |
| QQ next | ⏳ | shadow 通过后 |
| 网页/主动消息切换 | ⏳ | 最后 |
| D1/R2 免费额度 | ✅ | D1 1.23MB；R2 1.14MB / 13 objects |
| 2 周稳定门禁 | ⏳ | Phase 5 tag 前 |

---

## 4. 手机自动停止修复

### 4.1 发现的误判与根因

- `ds.sh status` 只看 `.run/client.pid`，而 `run-all.sh` 启动的进程不写这个旧 PID 文件；
- 所以客户端明明在跑，`status` 也可能显示“未运行”；
- 真正的停止是 tmux/run-all 会话被 Android 杀掉后，30s 自检也一起消失，没有东西再拉起；
- 20:04 的停止日志停在 6MB 图片上传 TLS 错误后，没有优雅退出记录，符合“进程被系统杀/崩溃”而非正常 shutdown。

### 4.2 已实施

- 新增 `ds-qq-client/watchdog.sh`：
  - 检查 tmux 会话、面板 dead、主进程；
  - 缺失时重建 `dsqq` 会话；
  - 写 `logs/watchdog.log`。
- `termux-job-scheduler` 已注册：

```text
job-id 1001
period 900000ms（15 分钟）
persisted true
battery-not-low false
```

- 另建一次性 job 1002 验证调度器确实会执行：
  - 23:09:27 `watchdog.log` 出现新的“检查完成”；
  - job 1002 已从 pending 消失；
  - 周期 job 1001 仍 pending。
- 周期 job 1001 首次自动执行：
  - 计划约 23:20，实际 23:21:00 写入 `watchdog.log`；
  - Android JobScheduler 有约 1 分钟调度延迟，属正常范围；
  - 后续继续每 15 分钟执行。
- 网页登录已由用户确认正常；不需要重置口令。

- `ds.sh start` 会额外触发 watchdog（会话存在但进程死掉时也能修）；
- `ds.sh status` 改为 `pgrep` 检测，不再依赖旧 PID 文件；
- `run-all.sh` 启动 client/NapCat 时更新 `.run/*.pid`。

### 4.3 恢复演练

```text
bash ds.sh stop
→ client down
sh watchdog.sh
→ 自动重建 dsqq 会话
→ client up
```

只杀主进程的故障注入：

```text
kill <main.py PID>
→ run-all 30s 自检在 40s 内拉起新 PID（13746 → 14853）
→ NapCat 重新连接
```

说明：只要 tmux/run-all 还活着，客户端单进程死掉能自愈；
如果 tmux 一起被杀，由 15 分钟 watchdog 负责；如果整个 Termux 被杀，
则依赖 Termux JobScheduler（一次性 job 1002 已验证能执行）。

进一步故障注入：只杀 `run-all.sh`：

```text
BEFORE_TMUX=no
BEFORE_RUNALL=no
sh watchdog.sh
AFTER_TMUX=yes
AFTER_RUNALL=yes
CLIENT=yes
```

watchdog 现在还会检查 `run-all.sh` 是否在；tmux 会话在但 supervisor 死掉时也会重建。

当前：

```text
client 运行中
napcat 运行中（已连接 QQ 2219827501）
```

### 4.4 大 GIF 上传修复（2026-10-24）

同一张 6,158,761 bytes 的 GIF 在 20:04 / 23:16 / 23:17 连续失败：

```text
SSL: SSLV3_ALERT_BAD_RECORD_MAC
Connection reset by peer
```

根因：Pillow 未安装 → 动图抽帧失败 → 回退为原图 base64；
6.15MB 原图变成约 8.2MB JSON，TLS 层被断连。另一张 5.90MB GIF 约 7.9MB JSON 可以成功。

修复：

- 安装 Pillow 13.0.0；
- 新增 `POST /api/upload/image` raw binary 直传，原图**不压缩**写 R2（上限 20MB）；
- 客户端先上传原图，再用帧拼图给模型；
- `image_keys` 只把 R2 key 写进聊天记录，不重复上传；
- `r2://` 兼容旧客户端。

验证：

```text
同一张 E268...gif（6158761 bytes）
→ 动图原图已直传 R2：images/2026-10-24/1792856446017.gif
→ 流式回复 114 字
→ 从 R2 下载核对：6158761 bytes，与原图一致
```

手机已插电（PLUGGED_AC/CHARGING），继续观察自动消息和上传稳定性。
- **安全提示**：`ds-qq-client/tests/_ssh_exec.sh` 等辅助脚本包含明文手机凭据，建议轮换手机密码并改为从环境变量读取；本次不会把凭据写入仓库或文档。

### 4.5 10/24 归档漏跑修复（2026-10-25）

10/24 的归档在 **13:54** 就跑过一次，当时只有 252 条消息（到 00:48），
次日 04:00 的正式归档因为 `cron_runs.status='done'` 被幂等跳过。

结果：

```text
D1 10/24: 342 条
R2 归档: 252 条，最后 ID 504
漏归档: 90 条（ID 505–594）
```

修复：

- `claimJob`：目标当天白天跑完的 done 视为**临时归档**，次日允许重跑；
- 手动补偿 `rearchive-logs`（distill=true）：
  - 342 条全部归档，最后 ID 594；
  - memory 6492→7521 字节；
  - 45 条记忆，0 重复；
  - 提炼费用 ¥0.1635。
- `engine_metrics` 迁移 008：CHECK 增加 `proactive`，否则
  `PROACTIVE_ENGINE=shadow` 的指标会被 D1 静默拒绝。

验证：

```text
cron_runs: 2026-10-24 done，342 条，09:17:10
R2: chat_logs/2026-10-24.log，342 条，253–594
readiness: facts=28 chunks=48 ready=true
```

---

## 5. 下一步

Phase 5 工程侧已完成，剩余是时间门禁：

1. 每天跑 `node scripts/p5-observe.mjs`，快照写入 `backup/p5-observation/`；
2. QQ shadow 连续观察 ≥7 天：看 `engine_metrics`、错误率、延迟、事实/情绪条目；
3. 无 P0 后切 `MEMORY_ENGINE_QQ=next` / `AFFECT_ENGINE_QQ=next`，再观察 ≥7 天；
4. 网页按 legacy → shadow → next 切换；主动消息代码已就绪，最后按 `PROACTIVE_ENGINE` 切换；
5. 2 周稳定后执行旧表/旧代码清理，再打 `refactor-p5`。

在那之前：
- 不回滚/不删除旧表；
- 不把网页切 next；
- 不启动 Phase 6。
