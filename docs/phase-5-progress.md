# Phase 5 进度报告：切换预检与 QQ 先行准备

> 日期：2026-10-24  
> 状态：🚧 进行中（**未执行生产迁移/部署**；等待确认与手机连接信息）  
> runbook：[phase-5-cutover.md](ds-memory/docs/phase-5-cutover.md)

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

- 检查 9 张新表是否存在；
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
vitest run       56 files / 687 tests ✅
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

### 1.6 生产打包预检

```text
wrangler deploy --dry-run
→ Total Upload: 741.40 KiB / gzip: 179.93 KiB
→ bindings 正常
→ 未部署
```

---

## 3. 未执行（需要确认/等待）

| 项 | 状态 | 说明 |
|---|---|---|
| 远程迁移 003–006 | ⏳ | 写生产 D1，需确认 |
| `AUTH_SECRET` 生产设置 | ⏳ | `wrangler secret put` |
| Worker 部署 | ⏳ | 默认 legacy 首部署 |
| QQ shadow 7 天 | ⏳ | 需部署 + 手机端观察 |
| QQ next | ⏳ | shadow 通过后 |
| 网页/主动消息切换 | ⏳ | 最后 |
| 2 周稳定门禁 | ⏳ | Phase 5 tag 前 |

---

## 4. 手机连接与安全

- 手机 SSH 已连通，只做了只读检查；
- 未启动客户端、未改配置、未重启 NapCat；
- 手机电量低且未充电，启动前需要确认是否接电源；
- **安全提示**：`ds-qq-client/tests/_ssh_exec.sh` 等辅助脚本包含明文手机凭据，建议轮换手机密码并改为从环境变量读取；本次不会把凭据写入仓库或文档。

---

## 5. 下一步

需要用户确认：

1. 是否先给手机接电源，再启动 `ds.sh start` 复现/观察 TLS 上传问题；
2. 是否允许执行生产迁移 003–006 + 部署（默认 legacy）；
3. 是否先只做 QQ shadow。

在确认前，Phase 5 保持“预检完成、未切线上”。
