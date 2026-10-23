# ds-memory · DeepSeek 长期记忆代理

> 部署在 Cloudflare 上的私人 AI 聊天代理：给 DeepSeek 加上**跨天记忆**、**时间/天气感知**、**关系演化**和**主动找你**的能力。
> 不需要服务器、不需要常驻进程、不需要公网 IP —— 一个 Worker + D1 + R2 + KV 就够了。

```text
你 → 网页 / QQ / 其他客户端 → Worker → 组装上下文（记忆 + 今天 + 关系 + 状态）
                                       → DeepSeek API（流式）
                                       ← 原样转发 + 落库 + 计费
```

## 特性

- **四层记忆**：长期（memory.md）/ 档案（R2，按需检索）/ 中期（最近 24 小时）/ 短期（最近 N 条原文）
- **每天自动提炼**：04:00 归档前一天对话，提炼成条目合并进 `memory.md`，超阈值自动压缩
- **关系数值**：好感度 / 亲密度 / 心情值三维独立演化，决定回复态度
- **活人感**：口语化风格、情绪残留、疲劳度、时段状态、反 AI 套话兜底
- **主动消息**：早晚两档 + 白天随机，按打分决策是否真的发；支持队列或直连推送
- **多端接入**：网页 SSE 聊天、OpenAI 兼容端点（AstrBot 等）、图片、文件
- **计费**：按 token 精确计算，含提炼/摘要费用；页头显示今日与近 7 天花费
- **全链路降级**：记忆/天气/提炼失败都不影响聊天主流程

## 技术栈

| 资源 | 用途 |
|---|---|
| Worker（Hono + TS） | 聊天代理、SSE 转发、定时任务 |
| D1 | 逐条消息、任务幂等、主动消息队列 |
| R2 | `memory.md`、记忆档案、每日上下文、归档日志、图片（可选双账号） |
| KV | 记忆缓存、24h 纪要、天气、会话、存储模式 |
| Workers AI | 提炼兜底（主用 DeepSeek，失败自动回退） |
| DeepSeek API | 对话（流式）与提炼 |

## 快速开始

需要 Node ≥ 20 与 Cloudflare 账号。

```bash
pnpm install

# 1) 创建资源（把输出的 id 填回 wrangler.toml 的 REPLACE_ME）
wrangler d1 create ds-memory-db
wrangler r2 bucket create ds-memory-r2
wrangler kv namespace create MEMORY_KV

# 2) 本地开发变量
cp .dev.vars.example .dev.vars      # 填 DEEPSEEK_API_KEY 与 ACCESS_PASSWORD_HASH
node scripts/hash-password.mjs '你的口令'   # 生成口令哈希

# 3) 初始化数据库与初始记忆
wrangler d1 execute ds-memory-db --remote --file=./schema.sql
wrangler r2 object put ds-memory-r2/memory.md --file=memory-template.md

# 4) 配置密钥并发布
wrangler secret put DEEPSEEK_API_KEY
wrangler secret put ACCESS_PASSWORD_HASH
wrangler deploy
```

部署后打开 Worker 域名，用口令登录即可聊天。`GET /api/health` 可检查各资源连通性。

### 本地开发

```bash
pnpm dev              # 本地 D1/R2/KV（空库，需要先 --local 建表）
pnpm dev --remote     # 连线上资源（注意：测试消息会写进线上 D1）
node scripts/try-chat.mjs "在干嘛"   # 命令行试聊，输出字数/行数/是否含列表
```

## 配置

### 变量（`wrangler.toml`）

| 变量 | 说明 |
|---|---|
| `CITY` / `LATITUDE` / `LONGITUDE` | 天气定位（Open-Meteo，无需 Key） |
| `DEEPSEEK_MODEL` | 对话模型，默认 `deepseek-flash` |
| `DISTILL_DEEPSEEK_MODEL` / `SUMMARY_DEEPSEEK_MODEL` | 提炼 / 摘要模型 |
| `DISTILL_MODEL` | Workers AI 兜底模型（DeepSeek 失败时用），默认 `@cf/meta/llama-3.2-3b-instruct` |
| `PRICE_*` | 计费单价（元/百万 tokens，高峰价；闲时自动减半） |
| `PROACTIVE_LEVEL` | 主动消息强度：`quiet` / `normal` / `active` |
| `STORAGE_THRESHOLD_BYTES` | 主账号 R2 容量阈值，超过后新写入切小号（默认 8.5GB） |
| `ASTRBOT_BASE_URL` / `ASTRBOT_UMO` | AstrBot 直连推送地址与会话 UMO；留空则走队列模式 |
| `CHARACTER_NAME` | 角色自称，缺省「小忆」；同时作用于系统提示词、状态卡和网页标题 |
| `USER_ADDRESS` | 角色怎么称呼你，缺省按记忆自然称呼；填了就会固定用它 |

### 换成你自己的角色（不改源码）

默认人设是「小忆」。想换成别的名字，只靠两个环境变量就够，源码保持干净，方便以后继续从上游拉更新：

```toml
[vars]
CHARACTER_NAME = "阿七"   # 角色自称（换成你喜欢的名字）
USER_ADDRESS   = "主人"     # 它怎么称呼你（可删，改用记忆里的称呼）
```

首页 HTML 由 Worker 接管并替换角色名，所以网页 `<title>` 也会跟着变。
为此 `[assets]` 需要配 `run_worker_first`（已写在 `wrangler.toml` 里），
这样只让首页走 Worker，图片等静态资源仍由 CDN 直出。

### 密钥（`wrangler secret put`）

| 名称 | 必填 | 说明 |
|---|---|---|
| `DEEPSEEK_API_KEY` | ✅ | DeepSeek 对话与提炼 |
| `ACCESS_PASSWORD_HASH` | ✅ | 网页口令哈希（`salt:sha256`） |
| `ASTROBOT_API_KEY` | 可选 | OpenAI 兼容端点 / 队列鉴权 |
| `SECONDARY_R2_*` | 可选 | 小号 R2（主账号容量用尽后自动切换） |
| `ASTROBOT_OPENAPI_KEY` | 可选 | AstrBot 直连推送 |

## 记忆系统

`memory.md` 八个固定分区：人物底色 / 称呼与关系 / 关于用户 / 偏好与习惯 / 进行中的事项 / 共同经历 / 雷区与禁忌 / 近期动态。

| 层 | 载体 | 尺度 | 注入 |
|---|---|---|---|
| 长期核心 | `memory.md`（≤6.5KB） | 永久 | 每轮全文（稳定前缀，可命中缓存） |
| 长期档案 | R2 `memory/archive.md` | 永久 | **按需检索**，命中才注入 |
| 中期 | KV `memo:24h` | 最近 24 小时 | 每 3 小时或 15 条消息滚动 |
| 短期 | D1 最近 20 条原文 | 当下 | 每轮 |

- **密度优先**：条目用「电报体」（去虚词、单条 ≤50 字），稳定事实用 `键=值`（同键原地覆盖）
- **分区配额**：每区有字节预算，超了先合并同类项（只合并、不删内容）
- **分层**：核心层超过 6.5KB 时，把「共同经历」最旧的条目搬进档案（只搬不删）
- **召回**：同义词扩展 + 行内标签加权 + 区分度打分，最多注入 4 条（约 150~300 字节）

## 主动消息

- 早晚两个时段（北京时间 07:45–08:15 / 22:45–23:15）+ 白天 09:00–22:30 随机 0~2 条
- **打分决策**：待跟进事项、天气变化、特殊日期、互动缺口、活跃时段；静默期与冷却期是否决项
- 投递两种模式：队列（客户端轮询 `proactive_queue`，无需公网入口，推荐）或直连 AstrBot HTTP API

## AstrBot 接入

Worker 提供 OpenAI 兼容端点，AstrBot 作为「OpenAI Compatible」服务商接入：

| 项 | 值 |
|---|---|
| Base URL | `https://<你的域名>/v1` |
| API Key | `ASTROBOT_API_KEY` 的值 |
| 模型 | 随便填（如 `deepseek-flash`）；服务端按 `DEEPSEEK_MODEL` 变量实际转发，不校验此字段 |

- 完整对话记录自动落 D1，参与每日归档与记忆提炼
- 平台包装（`<system_reminder>`、`<attachment>` 文件附件、图片占位）在落库前自动清洗
- 主动消息由客户端（如 [ds-qq-client](../ds-qq-client)）轮询队列投递；文件解析也在客户端侧完成

## API

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/health` | - | 资源连通性 |
| GET | `/api/day` | - | 当天上下文（含天气） |
| POST | `/api/login` / `/api/logout` | - | 口令登录（带失败限流） |
| POST | `/api/chat` | Cookie | SSE 聊天（支持图片、渠道标识） |
| GET | `/api/history`、`/api/history/since` | Cookie | 历史分页 / 增量拉取 |
| GET | `/api/usage` | Cookie | 计费统计（含提炼费用） |
| GET/POST | `/v1/models`、`/v1/chat/completions` | Bearer | OpenAI 兼容端点 |
| GET/POST | `/api/proactive/pending`、`/ack` | Bearer | 主动消息队列 |
| POST | `/api/admin/*` | Cookie | 手动归档 / 合并 / 触发主动消息 / 刷新 memory 缓存 |
| POST | `/api/admin/memory/refresh` | Cookie | 手动改完 R2 memory.md 后强制刷新 KV 缓存 |
| GET | `/api/admin/relation` | Cookie | 情感全貌（5 轴关系 / 8 维情绪 / 芥蒂） |
| POST | `/api/admin/emotion/simulate` | Cookie | 预览一段对话会生成的情绪快照 |

## 目录结构

```
src/
├── index.ts            # Worker 入口：路由 + cron 分发
├── chat.ts             # 网页聊天链路（SSE）
├── openai.ts           # OpenAI 兼容端点（AstrBot 等）
├── deepseek.ts         # DeepSeek 调用（流式/非流式）
├── prompt.ts           # 系统提示词组装（稳定→易变排序）
├── voice.ts            # 语言层：禁用词、口语化、长度控制
├── character-card.ts   # 角色状态卡：时段/疲惫/离线生活
├── memory.ts           # memory.md 读写（R2 + KV 缓存）
├── memory-maintenance.ts # 合并/压缩/裁剪/配额/键覆盖
├── memory-archive.ts   # 档案层 + 按需召回
├── recent-memory.ts    # 中期记忆（最近 24 小时纪要）
├── distill.ts          # 提炼与压缩（DeepSeek 优先，Workers AI 兜底）
├── jobs.ts             # 每日归档 / 月度合并 / context 刷新
├── proactive*.ts       # 主动消息：时间规则、打分决策、队列
├── attitude.ts / relation-*.ts  # 关系数值与态度矩阵
├── identity.ts         # 角色名/称呼解析（CHARACTER_NAME / USER_ADDRESS）
├── relation-store.ts   # 累计聊天天数持久化（防 D1 清理导致亲密度上限倒退）
├── emotion-*.ts        # 情感系统：事件 / 8 维情绪 / 快照 / KV 编排
├── relation-facets.ts  # 5 轴关系与关系原型
├── sse-scrub.ts        # 流式回复的 AI 味清洗（重写 SSE delta）
├── anti-ai-flavor.ts   # AI 套话确定性清洗（含空壳拦截）
└── media.ts / storage.ts / weather.ts / holidays.ts …
```

## 测试

```bash
pnpm build   # tsc --noEmit
pnpm test    # vitest（39 个测试文件，601 个用例）
```

## 隐私与免责

- 这是**单用户**项目：只有一个口令，没有注册、没有多用户隔离，请勿直接当 SaaS 使用
- 聊天记录存于你自己的 D1/R2，不会上传到第三方（除 DeepSeek / Workers AI 的模型调用）
- `.dev.vars`、`memory.md`、`chat_logs/` 已在 `.gitignore` 中，请勿提交真实密钥与聊天内容
- 本项目与 DeepSeek、Cloudflare 无隶属关系

## License

[MIT](./LICENSE)
