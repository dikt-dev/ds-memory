# Phase 1 完成报告：存储接缝与 KV 瘦身

> 日期：2026-10-24  
> 状态：✅ 完成（tag: `refactor-p1`）  
> 对应计划：`docs/refactor-execution-plan.md` Phase 1  
> 前置：Phase 0（tag `refactor-p0`）  
> 阶段 tag：`refactor-p1`

---

## 1. 目标回顾

Phase 1 不改记忆/关系行为，只做三件事：

1. 把高频运行时状态从 KV 迁到 D1；
2. 把登录态从 KV 改为无状态签名 Cookie；
3. 停掉低价值 KV 缓存，并加 KV 审计入口。

---

## 2. 完成清单

| 任务 | 状态 | 产出 |
|---|---|---|
| P1-A 存储接缝 | ✅（runtime/cache 层） | `src/runtime-store.ts`；Message/Raw 端口随 Phase 2 抽，避免过早抽象 |
| P1-B D1 runtime_state | ✅ | `schema.sql`、`migrations/003-runtime-state-auth.sql` |
| P1-C 无状态鉴权 | ✅ | `auth.ts` token/吊销；`index.ts` 登录/鉴权/全部登出 |
| P1-D 轮询优化 | ✅ | `public/index.html` 20s + 隐藏停止 + 立即补拉 |
| P1-E 清理低价值 KV | ✅ | 删除 `qvec` KV；`archive:cache` 改 isolate；摘要/纪要/锁/情绪/画像/天气/成本/文件/性格迁 D1 |
| P1-F KV 审计 | ✅ | `GET /api/admin/kv-audit` |

---

## 3. 迁移明细

### 3.1 已迁到 D1 `runtime_state`

| Key | 原 KV | 现存储 |
|---|---|---|
| `proactive:heartbeat` | 5 分钟写 | D1 runtime_state |
| `proactive:offline_alert` | 少量 | D1 |
| `proactive:paused_until` | 少量 | D1 |
| `emotion:state` | 每轮写 | D1 |
| `profile:user` / `profile:dirty` | 读多/节流写 | D1 |
| `memo:24h` / `memo:lock` | 3h/15 条 | D1 + D1 锁 |
| `summary:*` / `summary:lock:*` | 20 条/10 条 | D1 + D1 锁 |
| `weather:*` | 30 分钟 | D1 |
| `cost:llm:*` | 摘要/提炼 | D1 |
| `files:recent` | 文件上传 | D1 |
| `persona:state` | 每轮读/周写 | D1 |

### 3.2 已删除的低价值 KV

- `memory:qvec:*`：改为 isolate 内存缓存，冷启动重新 embedding；
- `archive:cache`：改为 isolate 缓存 + R2 回源。

### 3.3 仍保留在 KV 的内容

- `memory:cache`（memory.md 热缓存，读多写少）；
- `memory:index`（大索引对象，日更）；
- `relation:active_days`、`aversion:candidates`（日更）；
- `config:city`、`storage:mode`、`storage:usage`（低频）；
- `auth:revoked_before`（仅 D1 不可用时回退）；
- 登录失败计数（低频）。

> 代码中 KV `put/delete` 调用点从约 42 处降到 22 处，且剩余多为日更/低频/回退路径；每轮聊天的高频 KV 写已移除。

---

## 4. 鉴权设计

### 4.1 无状态 token

- 格式：`base64url(payload).base64url(HMAC-SHA256(payload))`；
- payload：`v/iat/exp/jti`；
- TTL：24 小时；
- 密钥：`AUTH_SECRET`；缺失时回退 `ACCESS_PASSWORD_HASH`（兼容，不推荐长期）；
- Cookie：`HttpOnly + Secure + SameSite=Strict`。

### 4.2 全部登出

- `POST /api/logout` body `{ "all": true }`；
- 写 D1 `auth_revocations` 的 `global` 行；
- `requireAuth` 校验 token 的 `iat` 是否早于全局吊销时间；
- D1 不可用时回退 KV `auth:revoked_before`。

### 4.3 回滚

- `AUTH_MODE=kv`：恢复旧 KV token 校验；
- 旧 KV token 仍写入/读取，便于灰度回退。

---

## 5. 验证结果

### 5.1 构建与测试

```text
tsc --noEmit     ✅
vitest run       47 files / 645 tests ✅
```

Phase 1 新增/更新测试：

- `auth.test.ts`：签名、篡改、过期、错误密钥、畸形 token、全局吊销；
- `runtime-store.test.ts`：KV 回退、读写删、锁；
- `channel-offline.test.ts`：适配 D1 runtime_state。

### 5.2 本地 D1 迁移

```text
wrangler d1 execute ... --local --file=./migrations/003-runtime-state-auth.sql
→ 3 commands executed successfully
```

### 5.3 心跳写 D1

本地 `wrangler dev` + Bearer 心跳：

```text
POST /api/proactive/heartbeat → {"ok":true}
```

本地 D1：

```text
runtime_state:
key=proactive:heartbeat
value={"at":"...","connected":true,...}
```

### 5.4 无状态鉴权 + 全部登出

```text
GET  /api/admin/kv-audit  (signed cookie) → 200
POST /api/logout {all:true}               → 200
GET  /api/admin/kv-audit  (same cookie)   → 401
```

说明：

- 签名 Cookie 可验证；
- 全局吊销生效；
- KV 审计可读；
- 未打印/提交 token 或密钥。

### 5.5 轮询

- `POLL_INTERVAL_MS=20000`；
- 隐藏标签页 `stopPolling()`；
- 可见时 `startPolling() + pollNewMessages()`；
- 发送流结束后补拉。

---

## 6. 门禁检查

- [x] 47 files / 645 tests 全绿；
- [x] tsc 通过；
- [x] 心跳写 D1，不再写 KV；
- [x] 登录签名为无状态，轮询不读 KV；
- [x] 全部登出生效；
- [x] `qvec`/`archive:cache` KV 路径移除；
- [x] KV 审计接口可用；
- [x] 手机端 Bearer API key 不受影响；
- [x] 未部署线上。

---

## 7. 遗留与风险

| 项 | 说明 | 处理阶段 |
|---|---|---|
| 线上指标未测 | Cloudflare Dashboard 的读写次数需部署后看 | Phase 5 |
| 迁移 003 未上远程 | 线上 D1 还没有 `runtime_state`/`auth_revocations` | Phase 5 部署前 |
| `AUTH_SECRET` 未设生产 | 本地已写入 `.dev.vars`（忽略）；生产需 `wrangler secret put` | Phase 5 |
| `AUTH_MODE=kv` 不支持全局吊销 | 回滚模式只清当前 Cookie | 文档说明 |
| `memory:cache`/`memory:index` 仍在 KV | 日更/大对象，Phase 2/4 再评估 | Phase 2/4 |
| Message/Raw 端口未抽 | 随 Memory Context 一起抽更自然 | Phase 2 |
| 本地假 DB 测试适配 | channel-offline 测试已适配 runtime_state | 已完成 |

---

## 8. 下一步：Phase 2

Phase 2 目标：Memory Context 抽离。

优先顺序：

1. 领域模型（facts/events/summaries/chunks/provenance/validity）；
2. D1 schema + 迁移；
3. 归档写入管线 + `memory_jobs`；
4. 召回读取管线 + 来源；
5. `memory.md` 投影 + 人工 pinned；
6. 双写/影子。

进入 Phase 2 前需确认：

- Phase 1 提交 + tag；
- 线上迁移 003 暂不执行（Phase 5 前统一部署）；
- `memory.md` 投影规则沿用“自动生成 + 人工 pinned”。
