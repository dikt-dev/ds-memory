# 备份与回滚 Runbook

> 适用：Phase 0–5 重构期间  
> 原则：**先备份、再变更；先验证、再删旧；生产不可逆操作必须人工确认**  
> 最后更新：2026-10-24

---

## 0. 快速检查清单

变更前：

- [ ] 记录当前 Worker 版本/部署 id；
- [ ] 记录当前 D1 表结构与关键行数；
- [ ] 导出/确认 `memory.md`、`memory/archive.md` 备份；
- [ ] 确认 `.dev.vars`、`wrangler.local.toml` 未进入 git；
- [ ] 确认 feature flag 默认值；
- [ ] 确认回滚命令可用。

变更后：

- [ ] `/api/health` 正常；
- [ ] 网页能登录、能发消息；
- [ ] QQ 私聊能收一条回复；
- [ ] 主动消息队列可拉取；
- [ ] 归档任务无 failed；
- [ ] 日志中无 P0 错误。

---

## 1. D1 备份

### 1.1 导出

```bash
cd D:/WorkSpace/ds-memory
mkdir -p backup
node node_modules/wrangler/bin/wrangler.js d1 export ds-memory-db \
  --remote \
  --config wrangler.local.toml \
  --output=./backup/d1-$(date +%Y%m%d-%H%M%S).sql
```

> 说明：导出是只读操作，但会消耗 D1 读额度；大库请避开高峰。

### 1.2 记录关键计数

```bash
node node_modules/wrangler/bin/wrangler.js d1 execute ds-memory-db \
  --remote --config wrangler.local.toml \
  --command="SELECT 'messages' AS t, COUNT(*) AS c FROM messages
             UNION ALL SELECT 'memory_entries', COUNT(*) FROM memory_entries
             UNION ALL SELECT 'cron_runs', COUNT(*) FROM cron_runs
             UNION ALL SELECT 'proactive_queue', COUNT(*) FROM proactive_queue;"
```

### 1.3 Time Travel

D1 免费版提供 7 天 Time Travel（以 Cloudflare 当前文档为准）：

```bash
node node_modules/wrangler/bin/wrangler.js d1 time-travel info ds-memory-db \
  --config wrangler.local.toml
```

恢复前必须：

- 记录当前时间点；
- 确认恢复目标时间；
- 先导出当前库；
- 在临时库/本地演练，不直接覆盖生产。

---

## 2. R2 备份

至少备份：

- `memory.md`
- `memory/archive.md`
- 最近 30 天的 `chat_logs/`（按需）
- 当前 `context/`（按需）

```bash
mkdir -p backup/r2
node node_modules/wrangler/bin/wrangler.js r2 object get \
  ds-memory-r2/memory.md \
  --file=./backup/r2/memory.md \
  --remote --config wrangler.local.toml

node node_modules/wrangler/bin/wrangler.js r2 object get \
  ds-memory-r2/memory/archive.md \
  --file=./backup/r2/archive.md \
  --remote --config wrangler.local.toml
```

> `chat_logs/` 可能很大，优先备份最近归档；全量备份用 `rclone`/S3 API，避免 wrangler 逐文件拉取。

### 验证

- 文件非空；
- `memory.md` 开头是 `# 长期记忆`；
- `archive.md` 能解析出 `- ` 条目；
- 记录文件大小与 SHA-256。

---

## 3. Worker 部署回滚

### 3.1 记录当前部署

```bash
node node_modules/wrangler/bin/wrangler.js deployments list \
  --config wrangler.local.toml
```

记录当前 deployment id、时间、版本说明。

### 3.2 回滚

```bash
# 具体子命令以当前 wrangler 版本为准：
node node_modules/wrangler/bin/wrangler.js rollback <deployment-id> \
  --config wrangler.local.toml
```

如果 wrangler 版本不支持 `rollback`：

1. 从 git 切到上一个 tag/commit；
2. `node node_modules/wrangler/bin/wrangler.js deploy --config wrangler.local.toml`；
3. 验证 `/api/health` 与一次聊天。

### 3.3 Feature flag 回滚

Phase 1 起应具备：

- `AUTH_MODE=kv|signed`
- `MEMORY_ENGINE=legacy|shadow|next`
- `AFFECT_ENGINE=legacy|shadow|next`
- `CHANNEL_ROLLOUT=web|qq|all`

回滚优先改 flag，不重新部署；flag 也要有默认值。

---

## 4. 恢复演练（不碰生产）

1. 导出 D1 到备份文件；
2. 用本地 D1 或临时库导入；
3. 对比关键表计数；
4. 随机抽样 20 条消息对比内容；
5. 读取 R2 `memory.md` 备份，确认可解析；
6. 记录演练结果到 `docs/baseline.md`。

**禁止**：在未备份、未确认目标的情况下对生产 D1 执行 restore/wipe。

---

## 5. 事故时的最小回滚顺序

1. 关闭新 feature flag；
2. 若仍异常，恢复上一版 Worker；
3. 若数据异常，停止写入（暂停 cron/客户端）；
4. 用备份恢复 D1/R2；
5. 记录事故时间线、影响范围、根因、后续动作。

---

## 6. 本次重构的阶段性回滚点

| 阶段 | 回滚点 |
|---|---|
| Phase 0 | 只加 trace/docs，无数据变更；直接 revert commit |
| Phase 1 | `AUTH_MODE=kv`、旧 KV 缓存路径保留 |
| Phase 2 | `MEMORY_ENGINE=legacy`，旧 `memory.md` 继续写 |
| Phase 3 | `AFFECT_ENGINE=legacy`，旧 KV emotion 保留 |
| Phase 4 | retrieval flag 回退旧召回 |
| Phase 5 | 按渠道 `CHANNEL_ROLLOUT` 回退；旧表保留 N 天 |
