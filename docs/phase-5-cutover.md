# Phase 5 切换 runbook（QQ → 网页 → 主动消息）

> 状态：**已备份、已迁移 003–007、已部署；QQ shadow 观察中，未切 next**  
> 原则：先只读预检 → 备份 → 迁移 → 部署（默认 legacy）→ QQ shadow → QQ next → 网页 → 主动消息 → 2 周观察。

---

## 0. 执行结果（2026-10-24）

- 备份：`backup/pre-p5/d1.sql`、`backup/pre-p5/memory.md`；
- 远程迁移 003–007：已完成，10 张新表存在；
- `AUTH_SECRET`：已设置；
- Worker：已部署，默认 legacy；
- Memory Context：23 facts / 13 events / 2 summaries / 38 chunks / 38 embedded；
- QQ：`MEMORY_ENGINE_QQ=shadow`、`AFFECT_ENGINE_QQ=shadow`；
- 网页：`MEMORY_ENGINE_WEB=legacy`、`AFFECT_ENGINE_WEB=legacy`；
- 手机客户端：已启动，NapCat 已连接。

下一步观察 QQ shadow ≥7 天，再切 `next`。

---

## 1. 切换前必须确认

- [ ] 已确认可以写生产 D1 / 部署 Worker；
- [ ] 已生成 `AUTH_SECRET`，不落 git；
- [ ] 已备份 D1 与 R2 `memory.md`；
- [ ] 已确认 QQ 客户端 `inject_history=true`，无需改协议；
- [ ] 已确认回滚窗口和负责人。

---

## 2. 迁移顺序

在 `ds-memory` 目录执行：
```bash
wrangler d1 execute ds-memory-db --remote --config wrangler.local.toml \
  --file=./migrations/003-runtime-state-auth.sql
wrangler d1 execute ds-memory-db --remote --config wrangler.local.toml \
  --file=./migrations/004-memory-context.sql
wrangler d1 execute ds-memory-db --remote --config wrangler.local.toml \
  --file=./migrations/005-memory-jobs.sql
wrangler d1 execute ds-memory-db --remote --config wrangler.local.toml \
  --file=./migrations/006-affect-context.sql
wrangler d1 execute ds-memory-db --remote --config wrangler.local.toml \
  --file=./migrations/007-engine-metrics.sql
```

全部是加法表；不删旧表。执行后用只读 SQL 检查：

```sql
SELECT name FROM sqlite_master WHERE type='table'
AND name IN ('runtime_state','auth_revocations','memory_facts',
             'memory_events','memory_summaries','memory_chunks',
             'memory_jobs','affect_events','attitude_snapshots',
             'engine_metrics');
```

---

## 3. 密钥与部署

```bash
wrangler secret put AUTH_SECRET --config wrangler.local.toml
wrangler deploy --config wrangler.local.toml
```

首次部署保持：

```toml
MEMORY_ENGINE = "legacy"
AFFECT_ENGINE = "legacy"
MEMORY_ENGINE_QQ = "legacy"
AFFECT_ENGINE_QQ = "legacy"
```

部署后登录，调用：

```text
GET /api/admin/readiness
```

要求：

- `ready=true`；
- `missing=[]`；
- `auth_secret_configured=true`；
- 先接受 `memory_engine=legacy` / `affect_engine=legacy` 的 warning。

---

## 4. QQ 先行 shadow

改生产变量（仍需 deploy 或 Dashboard 更新）：

```toml
MEMORY_ENGINE_QQ = "shadow"
AFFECT_ENGINE_QQ = "shadow"
```

观察：

- `[trace] memory.engine`：`oldItems/nextItems/oldBytes/nextBytes/hasVector/shadowMs`；
- `[trace] affect.policy`：archetype/tone/directives/policyMs；
- QQ 回复内容不变（shadow 不用新结果）；
- 错误率、首字延迟、DeepSeek 费用不升；
- `GET /api/admin/engine-metrics?days=7`：按天聚合 requests/old/new bytes/avg_ms。

建议至少 7 天；无 P0 才进入 next。

---

## 5. QQ 切读

```toml
MEMORY_ENGINE_QQ = "next"
AFFECT_ENGINE_QQ = "next"
```

验证：

- 记忆召回不再为空/不重复；
- 关系语气符合 `attitude-v1`；
- 不出现数值/真实意识/愧疚施压；
- 可一键回退 `legacy`。

---

## 6. 网页与主动消息

顺序：

1. `MEMORY_ENGINE_WEB=shadow` → `next`；
2. `AFFECT_ENGINE_WEB=shadow` → `next`；
3. 主动消息最后切（`webproactive` 仍走 legacy 召回/快照，Phase 5 后续再接）。

每一步观察 1–2 周。

---

## 7. 回滚

| 问题 | 动作 |
|---|---|
| 新召回变差 | `MEMORY_ENGINE_QQ/WEB=legacy` |
| 态度不自然 | `AFFECT_ENGINE_QQ/WEB=legacy` |
| 鉴权异常 | `AUTH_MODE=kv`（旧 KV token 兼容） |
| Worker 异常 | `wrangler rollback` 到上一版本 |
| 数据异常 | 加法表保留；用 D1 export/Time Travel + R2 `memory.md` 备份恢复 |

不要删除旧表/旧 `memory_entries`，直到连续 2 周稳定。

---

## 8. 2 周门禁

- [ ] QQ shadow ≥ 7 天，无 P0；
- [ ] QQ next ≥ 7 天，错误率/延迟/费用在预算内；
- [ ] 网页 next 稳定；
- [ ] readiness 全绿；
- [x] 回滚演练通过（2026-10-24：QQ legacy/shadow 双向切换 + record=false 200）；
- [ ] KV/D1 用量在免费额度内；
- [ ] README/architecture/runbook 更新。

全部通过后再打 `refactor-p5`，Phase 6 单独开始。
