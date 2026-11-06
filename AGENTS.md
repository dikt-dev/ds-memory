# AGENTS.md

给接手这个仓库的人（或模型）的操作约定。

## 发布纪律（每次改动都要做）

线上实例是 Cloudflare Worker `ds-memory`（https://fae.us.ci）。**改完必须同步上线**，不能只 commit：

1. `npx tsc --noEmit`
2. `npx vitest run`（全绿才发）
3. `git add -A && git commit`
4. `npx wrangler deploy --config wrangler.local.toml`
5. 验活：`https://fae.us.ci/api/health` 返回 `{"status":"ok","checks":{"d1":"ok","kv":"ok","r2":"ok","ai":"bound"}}`

> 只改配置（`wrangler.local.toml`）也必须重新 deploy —— vars 是部署时打包进去的。

## 配置与密钥

- `wrangler.local.toml`、`.dev.vars` 都在 `.gitignore` 里：改动不会出现在 commit 里，但 `wrangler deploy` 读的是**当前文件**，所以"提交里没有"不代表"没上线"。
- 模型只有一个来源：`LLM_<KIND>_MODEL`（chat / distill / summary / diary）。旧的 `DISTILL_DEEPSEEK_MODEL` / `SUMMARY_DEEPSEEK_MODEL` 已删除，不要再加回来。
- 改 R2 里的 `persona.md` / `memory.md` 后要清 KV 缓存（`cache:persona:doc` / `memory:cache`），否则 30 秒 ~ 24 小时不生效。

## 约定

- 记忆、提炼输入的主语只用「他 / 你 / 一起」；`用户 / 助手 / 她` 不进记忆。
- 提示词优先写正向引导，少写「不要 / 禁止」；真正的硬约束（主语归属、格式）靠示例钉住。
- 线上排查先看 `cron_runs.detail`（归档/提炼/日记都有费用和条目数）和 `/api/health`。

## 常用命令

```bash
npx wrangler deploy --config wrangler.local.toml        # 发布
npx wrangler d1 execute ds-memory-db --remote --config wrangler.local.toml --command "select ..."
npx wrangler r2 object get ds-memory-r2/memory.md --remote --config wrangler.local.toml --file=memory.md
npx wrangler kv key delete "cache:persona:doc" --namespace-id=<id> --remote --config wrangler.local.toml
```
