# 本地可复现环境

> 2026-10-31 建立。解决的是这个项目最贵的一个问题：**改了看不见**。

## 1. 为什么需要它

`wrangler tail` 在开发者的网络上连不上（到 `173.231.12.107:443` 超时），线上日志等于没有。
于是过去三次翻车都是同一个模式：改代码 → 部署 → 用户说「没变化」→ 分不清是代码、缓存还是部署没生效。

有了本地环境，改动可以在「真实数据 + 真实 SQL」上先跑出结论，再决定上不上线。
配套的 `request_log`（见 `src/request-log.ts`）让线上也有可比对的耗时数据。

## 2. 用法

```powershell
cd D:\WorkSpace\ds\ds-memory

# 导出线上 D1 → 清空本地 → 导入 → 起 worker（默认 8799 端口）
.\scripts\local-env.ps1

# 复用上次的快照，直接起（省 20~60 秒）
.\scripts\local-env.ps1 -SkipExport
```

起来之后：

```powershell
curl http://127.0.0.1:8799/api/health
curl http://127.0.0.1:8799/api/day
```

## 3. 覆盖范围与已知空白

| 资源 | 本地状态 | 说明 |
|---|---|---|
| D1 | 与线上一致 | messages / memory_facts / memory_events / memory_chunks / runtime_state / engine_metrics / cron_runs … 全部导入 |
| KV | 空 | 记忆缓存、摘要、锁都在这里；空 KV 会让代码走「回源/重建」路径，恰好能测降级 |
| R2 | 空 | **`memory.md` 在 R2 里，所以本地长期记忆为空**——需要完整复现时手动放一份 |
| Workers AI | 本地是桩 | 向量召回在本地退化成纯关键词，正好是我们要测的降级路径 |
| DeepSeek | 真 key | `.dev.vars` 里的 key 会真的被调用，**聊天会计费** |

要把 `memory.md` 也搬下来，二选一：

```powershell
# A. 用仓库里已有的记忆快照
Copy-Item .\backup\r2\memory.md .\tmp\memory.md

# B. 从线上接口确认当前大小（需要登录 cookie）
curl -H "Cookie: ds_token=..." https://fae.us.ci/api/admin/stats
```

本地 R2 落盘位置在 `.wrangler\state\v3\r2\`，把文件放进去即可被 `getObject` 读到。

## 4. 登录本地实例

本地同样用签名 cookie。两种办法：

1. **走正常登录**：浏览器开 `http://127.0.0.1:8799`，用平时的口令（`ACCESS_PASSWORD_HASH` 在 `.dev.vars` 里）。
2. **直接签一个 token**（脚本调试用）：`AUTH_SECRET` 在 `.dev.vars` 里，用 HMAC-SHA256 签
   `base64url(payload) + "." + base64url(sig)`，payload 是 `{v:1, iat, exp, jti}`，带 header
   `Cookie: ds_token=<token>`。实现见 `src/auth.ts` 的 `signAuthToken`。

> 只在本地用。生产的 `AUTH_SECRET` 是另一份，签不出来——这本身也是「部署是否用对密钥」的检验办法。

## 5. 数据安全

- 快照里有真实对话， `tmp/` 与 `.wrangler/` 已写进 `.gitignore`；
- 调试完 `Remove-Item -Recurse .\tmp`；
- 不要把 `wrangler.local.toml`（含资源 id）和 `.dev.vars`（含密钥）提交。

## 6. 已验证

2026-10-31 实测：导入 276 条消息 + 21 张表 → `/api/health` 全 ok（d1/kv/r2 本地均通过）→
`/api/admin/requests` 返回 200，且 `request_log` 被惰性建好、写入了 3 行。