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

## 4. 手机连接（待补充）

用户已开启手机 SSH/FTP，但需要：

- 手机局域网 IP（或 Tailscale/ZeroTier 地址）；
- SSH 用户名 + 端口（Termux 常见 8022）；
- FTP 端口（常见 21）；
- 允许执行的范围（只读检查 / 重启客户端 / 部署）。

凭据不会写入仓库或文档。
