# 当前状态

> **本次核对：2026-11-09 14:35**（上一版是 10-31，数字已全部重测）。
> 第 0 节是现在的事实；第 1 节往后是 Phase 0 基线原文（10-24），路线/模型/测试数量已被后续实现取代，冲突时以代码为准。

## 0. 现状速览（2026-11-09 核对）

| 项 | 现在 |
|---|---|
| 线上版本 | Version `e7a97c10`（11-09 14:33 部署），`/api/health` 200 |
| 仓库 HEAD | `6b809fe`（11-10，动作疲劳兜底那次；本地领先 origin，未 push） |
| 引擎开关 | `MEMORY_ENGINE*`=**next**（全渠道）、`MEMORY_PROMPT_MODE`=tiered、`AFFECT_ENGINE*`=shadow、`PROACTIVE_ENGINE`=shadow、`VOICE_MODE`=**lite**（三档：bare 6 条 / lite 11 条 / full 17 条，一行配置切） |
| 测试 | **151 个文件 / 1,509 个用例**全绿，`tsc --noEmit` 干净（11-10 11:43 实跑） |
| 记忆规模 | `memory.md` **3,260 字符**（11-10 实测，压缩后）；`memory_chunks` 99 行（档案 39 / 共同经历 26 / 近期动态 11 / 他的偏好 9 / 关于他 4 / 你的生活 4 / 进行中的事 3 / 答应过的事 2 / 摘要 1） |
| 记忆空分区 | 「人物底色」1 条（上限 20；distill 已改成「每天至少一条」，11-10 上线，次日 04:00 归档后见效）；「他的雷区」0 条——aversion 阈值 2 次、由每日归档写入，**空=还没踩到，不是没接线** |
| 已知冗余 | `memory_links`（`memory-links.ts` 标 `@unwired`）没有写入方，但 `memory-jobs` 每天仍在删过期行、`self-check` 仍在统计断链；接线或清理二选一，暂未动 |
| 会话连续 | 整段会话（≤200 轮）→ 最近 30 轮原文 + 更早的提要；实测 11-08 那场 41 轮：原文 1,959 字 + 提要 512 字，一轮不丢 |
| 召回 | 覆盖率短路生效：排序 0 ms、选择器只在有未覆盖条目时跑；实测 total **4~7 ms**（快照前提是 chunk 缓存命中），冷读约 440 ms |
| 探针 | 10 题：**9/10**（11-09 实测）；归档后自动跑（平日 1 发 / 周日 3 发取多数），历史在 `probe_runs` |
| 模型分工 | 对话 `deepseek-flash`（关思考）；提炼 `qwen3.8-max`；摘要 `deepseek-v4.1-flash-1017`；日记 `deepseek-flash`；兜底 Workers AI |
| 成本 | 每日归档提炼 ≈ ¥0.026；探针 ≈ ¥0.14/天（含周日 3 发） |
| 已知问题 | ① `ChatUi.kt` 1,909 行 / `ApiClient.kt` 1,422 行待拆；② 两个仓库 421 / 57 个提交只在本地；③ `memory-rollups` / `memory-summaries` / `memory-dual` 未接线（已标 @deprecated） |

### 0.1 10-31 之后做完的（按主题）

```text
上下文快照 ctx:snapshot:v2   7 次跨区读 → 1 次 KV 读；memo 保留原始 items
召回覆盖率短路               已注入的条目不重复召回；召回 1,306 ms → 4~7 ms
实体折叠 + 跨分区去重        进行中的事 6→2、剥虾三处→一处；预算 3000→9000
档案召回修复                 origin 列写错导致「降级=静默删除」，已补回 26 条
归档后自动探针               平日 1 发 / 周日 3 发；历史落 probe_runs
看图与复读                   1568px / PNG 无损；「看不清就说看不清」「回一句他没说过的」
```

### 0.2 记忆链路的读数从哪来

```text
engine_metrics / engine_cpu   D1，按天聚合（请求侧只提交不阻塞）
recall_samples                D1，逐条分段：load / rank / select / covered / uncovered
probe_runs                    D1，探针历史；eval:probe:last 只存最后一次
cron_runs                     D1，每日归档 detail：去重 / 分层 / 降级 / 探针 四个数
```
## 1. 代码与运行形态（Phase 0 基线，10-24 原文）
|---|---|
| Cloudflare Worker | `ds-memory`，Hono + TypeScript |
| 入口 | `src/index.ts` |
| 前端 | `public/index.html`，单页、零构建 |
| 运行时 | Cloudflare Workers（免费计划） |
| 存储 | D1 + R2（主/小号）+ KV + Workers AI |
| 模型 | DeepSeek `deepseek-flash`（对话）、`deepseek-v4-pro`（每日提炼，2026-10-30 起改带思考）、Workers AI 兜底 |
| 手机端 | DS-Mobile（Android App，`com.dsmobile.app`），经 `/api/app/*` 直连 |
| 测试 | 69 个测试文件、765 个用例（2026-10-30） |
| 构建检查 | `tsc --noEmit` |

---

## 2. 请求拓扑

```text
网页 / QQ / AstrBot
        ↓
Worker
  ├─ 鉴权（KV cookie / Bearer）
  ├─ 记忆：memory.md + archive + memo + 10 轮历史 + 召回
  ├─ 关系/情绪：memory.md 数值 + KV emotion:state
  ├─ 人设：prompt.ts + character-card + persona-drift
  └─ DeepSeek
        ↓
D1 messages / cron_runs / proactive_* / memory_entries
R2 memory.md / archive / chat_logs / context / images
KV auth / memory cache / memo / summary / emotion / heartbeat / ...
```

---

## 3. HTTP 路由

### 3.1 网页 / 管理

| 方法 | 路径 | 鉴权 | 用途 |
|---|---|---|---|
| GET | `/` | - | 聊天页面（Worker 注入角色名） |
| GET | `/api/health` | - | 资源连通性 |
| GET | `/api/day` | - | 当天上下文 |
| GET | `/api/balance` | Cookie | DeepSeek 余额 |
| GET | `/api/settings` | - | 城市配置 |
| POST | `/api/admin/settings` | Cookie | 修改城市 |
| POST | `/api/login` | - | 口令登录 |
| POST | `/api/logout` | - | 退出 |
| POST | `/api/chat` | Cookie | SSE 聊天 |
| GET | `/api/image/*` | Cookie | 图片回放 |
| GET | `/api/history/since` | Cookie | 增量历史（网页 3s 轮询） |
| GET | `/api/history` | Cookie | 历史分页 |
| GET | `/api/usage` | Cookie | 计费统计 |

### 3.2 管理 / 维护

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/api/admin/memory/refresh` | 清 KV memory 缓存并回源 |
| POST | `/api/admin/memory/reindex` | 重建 D1 记忆索引 |
| POST | `/api/admin/memory/reload` | 刷新缓存 + 重建索引 |
| POST | `/api/admin/memory/rollup` | 生成周/月摘要 |
| POST | `/api/admin/wipe-data` | 清空 D1/R2/KV（危险） |
| POST | `/api/admin/run-daily` | 手动归档 |
| POST | `/api/admin/rearchive-logs` | 重建 R2 日志（默认不再提炼） |
| POST | `/api/admin/run-monthly` | 手动月度合并 |
| POST | `/api/admin/test-mood` | 情绪 AI 复核自检 |
| GET | `/api/admin/relation` | 情感全貌 |
| POST | `/api/admin/emotion/simulate` | 情绪模拟 |
| POST | `/api/admin/run-context` | 刷新 context |
| GET | `/api/admin/stats` | 统计 |
| POST | `/api/admin/proactive-send-now` | 手动主动消息 |
| POST | `/api/admin/proactive-diagnose` | 主动消息诊断 |
| POST | `/api/admin/trigger-proactive` | 触发主动消息 |

### 3.3 OpenAI 兼容 / 队列

| 方法 | 路径 | 鉴权 | 用途 |
|---|---|---|---|
| GET | `/v1/models` | Bearer | 模型列表 |
| POST | `/v1/chat/completions` | Bearer | QQ/AstrBot 聊天 |
| GET | `/api/proactive/pending` | Bearer | 拉取主动消息 |
| POST | `/api/proactive/ack` | Bearer | 确认送达 |
| POST | `/api/proactive/nack` | Bearer | 发送失败 |
| GET | `/api/proactive/stats` | Cookie | 队列统计 |
| POST | `/api/proactive/drop` | Bearer | 丢弃积压 |
| POST | `/api/proactive/pause` | Bearer | 退订 |
| POST | `/api/proactive/heartbeat` | Bearer | 手机心跳 |

---

## 4. Cron

| Cron（UTC） | 北京时间 | 内容 |
|---|---|---|
| `0 20 * * *` | 04:00 | 每日归档前一天；每月 1 日再跑月度合并 |
| `*/5 1-14 * * *` | 09:00–22:30 | 随机主动消息 + 16:00 context 刷新 + 通道检查 |
| `*/5 23,0,14,15,16 * * *` | 07:45–08:15 / 22:45–23:15 | 早晚主动消息 + 08:00/24:00 context 刷新 + 通道检查 |

---

## 5. D1 表

| 表 | 用途 | 关键字段/约束 |
|---|---|---|
| `messages` | 逐条消息 | `turn_id`、`turn_type`、`reply_to_id`、`channel`、`date_key`、`created_ms`、费用/token |
| `cron_runs` | 定时任务幂等 | `UNIQUE(job_type,target)`、`status` |
| `proactive_log` | 主动消息幂等 | `UNIQUE(date_key,slot_key)` |
| `proactive_feedback` | 主动消息反馈 | `UNIQUE(message_id)` |
| `proactive_queue` | 外发队列 | `leased_at`、`attempts`、`sent_at` |
| `memory_entries` | 记忆检索索引 | `vec`、`keywords`、`tags`、`dup_of`、`source` |
| `memory_rollups` | 周/月摘要 | `id=level:period` |

> `memory_entries.dup_of` 已在 schema 与线上库存在；迁移 002 用于其他环境。

---

## 6. R2 对象

| Key | 用途 | 清理策略 |
|---|---|---|
| `memory.md` | 长期记忆核心/快照 | 不自动删 |
| `memory/archive.md` | 长期档案 | 不自动删 |
| `memory/backups/*.md` | 重新提炼前备份 | 手动 |
| `context/YYYY-MM-DD.json` | 当天上下文（天气/关系/提炼） | 90 天 |
| `chat_logs/YYYY-MM-DD.log` | 单日归档（JSON） | 月度合并后删单日 |
| `chat_logs/YYYY-MM.json` | 月度归档 | 保留 |
| `images/YYYY-MM-DD/*.jpg` | 聊天图片 | 不自动删 |

双账号：主 R2 达阈值后新写入切小号；读取按存储模式（Phase 1 前主账号优先）。

---

## 7. KV Key

| Key | 用途 | TTL | 频率 | 目标 |
|---|---|---|---|---|
| `auth:*` | 网页登录态 | 7 天 | 每次网页请求读 | 无状态 Cookie |
| `login:fail:*` | 登录失败限流 | 10 分钟 | 登录时 | 可保留/D1 |
| `memory:cache` | memory.md 缓存 | 24h | 每轮读 | isolate/D1 |
| `memory:index` | 记忆索引大对象 | 1h | 冷启动读 | isolate/D1 |
| `memory:qvec:*` | query 向量缓存 | 1h | 每新 query 读写 | 删除，isolate LRU |
| `archive:cache` | 档案缓存 | 5 分钟 | 召回读 | isolate/R2 |
| `memo:24h` | 24h 纪要 | 48h | 每轮读 | D1 |
| `memo:lock` | 纪要锁 | 120s | 刷新时 | D1 |
| `summary:*` | 今日摘要 | 36h | 每轮读 | D1 |
| `summary:lock:*` | 摘要锁 | 120s | 生成时 | D1 |
| `emotion:state` | 情绪向量/事件 | 90 天 | 每轮读写 | D1 |
| `profile:user` | 用户画像 | 6h | 主动消息读 | D1 |
| `profile:dirty` | 画像脏标记 | 24h | 每轮可能写 | D1 |
| `proactive:heartbeat` | 手机心跳 | 7 天 | 每 5 分钟写 | D1 |
| `proactive:offline_alert` | 掉线提醒 | 7 天 | 少量 | D1 |
| `proactive:paused_until` | 退订截止 | 无 | 少量 | D1 |
| `weather:*` | 天气缓存 | 30 分钟 | 每轮读 | D1/isolate |
| `cost:llm:*` | 非聊天费用 | 8 天 | 摘要/提炼 | D1 |
| `files:recent` | 最近文件 | 7 天 | 每轮读 | D1（可选） |
| `persona:state` | 性格漂移 | 无 | 每轮读/周写 | 可保留 |
| `relation:active_days` | 累计天数 | 无 | 日读/写 | D1（可选） |
| `aversion:candidates` | 雷区候选 | 30 天 | 日读/写 | D1（可选） |
| `storage:mode` | 主/小号 R2 | 无 | 写时读 | isolate 缓存 |
| `storage:usage` | R2 用量 | 6h | 日检查 | D1（可选） |
| `config:city` | 城市配置 | 无 | 每轮读 | isolate + KV/D1 |

> **Phase 1 更新**：`auth` 改为无状态签名 Cookie；`proactive:heartbeat`、`emotion:state`、`profile:*`、`memo/summary` 内容与锁、`weather:*`、`cost:llm:*`、`files:recent`、`persona:state` 已迁到 D1 `runtime_state`；`memory:qvec:*` 与 `archive:cache` 已删除 KV 路径。仍保留 KV 的主要是 `memory:cache`、`memory:index`、`relation:active_days`、`aversion:candidates`、`config:city`、`storage:*` 等低频/大对象。

> 当前免费额度：KV 读 100,000/天、写 1,000/天、删 1,000/天。

---

## 8. 当前记忆/关系链路

### 8.1 每轮聊天

1. 鉴权（Cookie/KV 或 Bearer）；
2. `getMemory`（KV→R2）；
3. `extractPromptMemory`（≤16KB 全量；否则核心+稳定画像）；
4. 短期历史：`/api/chat` 用 `loadSessionHistory`（整段会话，6 小时间隔为界，最多 200 轮）→
   `buildHistorySlice` 切成「最近 30 轮原文 + 更早的提要」；
   `/v1/chat/completions` 用 `loadRecentRounds`（默认 18 轮，技术类 60；D1 + R2 补）；
   两条链路都不再按 30 轮暗限截断，被挤掉的轮次压成提要注入，不再静默消失（2026-11-09）；
5. `getRecentMemo` / 今日摘要；
6. `recallMemoryForChat`（关键词优先，必要时向量）；
7. `processEmotionTurn`（读 KV `emotion:state`，可能写回）；
8. 组装 prompt（核心 + 历史 + memo + 召回 + 角色卡 + 态度）；
9. DeepSeek；落 D1；异步摘要/memo。

### 8.2 每日归档

1. 存储容量检查；
2. 反馈回填、队列清理、R2 context 清理；
3. 补跑 failed/stale/D1 未归档日期；
4. 写 `chat_logs/日期.log`；
5. 提炼 `memory.md`；失败标 failed；
6. 情绪/关系结算；
7. 近期动态归档、已完成事项、雷区学习；
8. 去重、超 24KB 无损分层；
9. 写回 `memory.md` + 重建索引 + 周月摘要；
10. 清理 D1（只删已归档且提炼成功的日期）。

---

## 9. 当前测试与基线

| 项 | 值 |
|---|---|
| 测试文件 | 58（基线 45；Phase 0 trace，Phase 1 auth/runtime，Phase 2 memory，Phase 3 affect，Phase 4 retrieval，Phase 5 flags/metrics） |
| 测试用例 | 699（基线 631；Phase 0 +6，Phase 1 +8，Phase 2 +25，Phase 3 +7，Phase 4 +7，Phase 5 +11。**2026-10-30 实为 765**） |
| 类型检查 | `node node_modules/typescript/bin/tsc --noEmit` |
| 测试命令 | `node node_modules/vitest/vitest.mjs run` |
| 关键测试 | 短期历史、记忆合并/去重、摘要触发、召回、关系/情绪、归档、队列、API 解析 |

---

## 10. 已知问题与重构目标

| 问题 | 目标阶段 |
|---|---|
| KV 承担高频状态，免费额度易耗尽 | Phase 1 |
| 鉴权每次轮询读 KV | Phase 1 |
| 网页 3s 轮询，请求量大 | Phase 1 |
| emotion/profile/summary/weather 分散在 KV | Phase 1 |
| memory.md 同时承担真相/投影/关系值 | Phase 2/3 |
| 记忆按行索引，缺来源/有效期/置信度 | Phase 2/4 |
| 关系/情绪无数值事件账本，难解释/回放 | Phase 3 |
| 检索单路 query、分数直接相加 | Phase 4 |
| 缺少 golden set、trace、评估体系 | Phase 0 |

---

## 11. 本轮重构不动的部分

- DS-Mobile 的媒体/TTS 实现；
- `/api/chat`、`/v1/chat/completions`、`/api/proactive/*` 的外部契约；
- `memory.md` 作为导出/快照的兼容性；
- 单用户模型（不引入多租户）。
