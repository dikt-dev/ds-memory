# DeepSeek 长期记忆代理 —— 项目总览与阶段规划

> 版本 v1.1 ｜ 日期 2026-10-21 ｜ 状态：已确认，进入实施
> 部署平台：Cloudflare（Worker + D1 + R2 + KV + Workers AI）

---

## 一、项目总览

### 1.1 项目定位

在 Cloudflare Worker 上部署一个 DeepSeek 聊天代理。它与 DeepSeek 官方 API 之间多了一层"记忆系统"：

- 长期记忆存放在 R2 的 `memory.md` 中（目标 ≤12KB），每次聊天自动注入；
- 每次聊天同时注入：时间戳、当天日期、是否节假日（中国法定节假日 + 周末）、天气；
- 所有对话逐条落 D1，每天凌晨 4 点（北京时间）自动归档到 R2，并用 Workers AI 提炼当天内容合并进 `memory.md`；
- `memory.md` 缓存进 KV（TTL 24h），聊天读取走 KV，不再每次读 R2。

### 1.2 核心闭环

```
聊天：  前端页面 → Worker → 注入(记忆/日期/节假日/天气/最近10轮) → DeepSeek API(流式) → 原样转发前端
        user 消息、assistant 回复逐条写入 D1

每日：  北京时间 04:00（cron 20:00 UTC）
        打包前一天完整对话 + 当天上下文/天气快照 → R2 chat_logs/YYYY-MM-DD.log
        Workers AI 提炼当天要点 → 合并进 memory.md → 大小维护 → 刷新 KV 缓存

每月：  每月 1 日 04:05（cron 1 日 20:05 UTC）
        上月所有单日 .log 合并成 chat_logs/YYYY-MM.json 后删除单日文件
        清理 D1 中 3 个月前的消息
```

### 1.3 需求决策记录（已与你确认）

| # | 决策点 | 结论 |
|---|--------|------|
| 1 | R2 日志结构 | 单日 `.log` 存档，每月 1 日合并成月度 JSON 后删除单日文件 |
| 2 | 天气数据源 | Open-Meteo（免费、无 API Key），城市做成配置项 |
| 3 | 节假日口径 | 中国法定节假日 + 周末；内置国务院年度调休表，Worker 内判断 |
| 4 | 前端回复方式 | SSE 流式输出（打字机效果） |
| 5 | 页面鉴权 | 简单访问口令（登录后发 Cookie/Token） |
| 6 | images/ 目录 | 本期不做图片功能，仅预留目录 |
| 7 | memory.md 阈值 | >12KB 触发二次提炼；提炼后仍 >15KB 删除最旧记忆 |
| 8 | D1 保留策略 | 长期保留，按月归档后清理 3 个月前的数据 |
| 9 | 会话结构 | 单一连续会话，每次注入最近 10 轮历史 |
| 10 | DeepSeek 模型 | 默认 `deepseek-chat`（环境变量可换） |

### 1.4 技术选型

| 项 | 选型 | 说明 |
|----|------|------|
| 运行时 | Cloudflare Workers（TypeScript） | 路由框架用 Hono |
| 数据库 | Cloudflare D1 | 消息表、定时任务防重表 |
| 对象存储 | Cloudflare R2 | memory.md、context/、chat_logs/、images/ |
| 缓存 | Cloudflare KV | memory 缓存(24h)、天气缓存(30min)、登录会话(7d) |
| AI 提炼 | Workers AI | 默认 `@cf/llama/llama-3.1-8b-instruct`（可配），提炼/压缩记忆 |
| 对话模型 | DeepSeek API | `deepseek-chat`，流式，API Key 存 Worker Secret |
| 定时任务 | Cloudflare Cron Triggers | 每日 20:00 UTC；每月 1 日 20:05 UTC |
| 前端 | 原生 HTML/CSS/JS 单页 | 由 Worker 静态托管（Assets），零构建 |
| 部署工具 | Wrangler CLI | 本地 dev + 一键发布 |

### 1.5 系统架构

```
                        Cloudflare
┌─────────────┐   HTTPS/SSE   ┌───────────────────────────────┐
│  浏览器      │ ◄──────────► │  Worker（TS + Hono）           │
│  聊天页面     │              │   ├─ 口令鉴权                   │
└─────────────┘              │   ├─ 上下文组装器               │
                             │   ├─ /api/chat (SSE 转发)       │
        ┌──────────────┐     │   ├─ /__cron/daily (每日归档)   │
        │ Cron Trigger │────►│   └─ /__cron/monthly (月度合并) │
        └──────────────┘     └──────┬──────────┬──────────┬────┘
                                    │          │          │
                            ┌───────▼──┐ ┌─────▼────┐ ┌───▼──────┐
                            │ D1       │ │ KV       │ │ R2       │
                            │ 消息表    │ │ 缓存     │ │ 归档/记忆 │
                            └──────────┘ └──────────┘ └──────────┘
                                     │
                          ┌──────────▼──────────┐   ┌──────────────┐
                          │ DeepSeek API        │   │ Open-Meteo   │
                          │ (对话, stream)       │   │ (天气)        │
                          └─────────────────────┘   └──────────────┘
                                     │
                          ┌──────────▼──────────┐
                          │ Workers AI          │
                          │ (每日提炼/压缩记忆)   │
                          └─────────────────────┘
```

### 1.6 存储设计

#### R2 目录结构（最终版）

```
R2 根目录/
├── memory.md                    # 核心长期记忆，目标 ≤12KB
├── context/
│   └── 2026-10-21.json          # 当天上下文快照（日期/星期/节假日/天气）
├── chat_logs/
│   ├── 2026-10-21.log           # 单日日志（内容为 JSON），月末合并后删除
│   └── 2026-10.json             # 月度归档（合并产物）
└── images/                      # 预留，本期不使用
```

`context/2026-10-21.json` 示例：

```json
{
  "date": "2026-10-21",
  "weekday": "星期三",
  "is_holiday": false,
  "holiday_note": "工作日",
  "weather": { "city": "北京", "temp_c": 18.5, "desc": "晴" }
}
```

`chat_logs/2026-10-21.log` 内容示例（后缀 .log，内容为 JSON）：

```json
{
  "date": "2026-10-21",
  "context": { "…同 context 文件…" },
  "messages": [
    { "id": 123, "role": "user",      "content": "…", "created_at": "2026-10-21T09:12:03+08:00" },
    { "id": 124, "role": "assistant", "content": "…", "created_at": "2026-10-21T09:12:30+08:00" }
  ]
}
```

月度 `2026-10.json` = 当月各单日 .log 的合并（按 `messages.id` 排序去重）。

#### D1 表结构

```sql
CREATE TABLE messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  role       TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content    TEXT NOT NULL,
  date_key   TEXT NOT NULL,          -- 北京时间 'YYYY-MM-DD'
  created_at TEXT NOT NULL           -- 北京时间 ISO8601
);
CREATE INDEX idx_messages_date ON messages(date_key);

CREATE TABLE cron_runs (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  job_type TEXT NOT NULL,            -- 'daily_archive' | 'monthly_merge'
  target   TEXT NOT NULL,            -- 'YYYY-MM-DD' 或 'YYYY-MM'
  status   TEXT NOT NULL,            -- 'running' | 'done' | 'failed'
  detail   TEXT,
  run_at   TEXT NOT NULL,
  UNIQUE(job_type, target)           -- 幂等：同一天/月只跑一次
);
```

#### KV 键设计

| 键 | 值 | TTL | 用途 |
|----|----|-----|------|
| `memory:cache` | memory.md 全文 | 24h | 聊天时读记忆，每日任务完成后刷新 |
| `weather:{city}` | `{temp_c, desc, updated_at}` | 30min | 天气缓存 |
| `auth:{token}` | `"1"` | 7d | 登录会话 |

### 1.7 数据流详解

#### A. 聊天链路（POST /api/chat）

1. 校验登录 Token（KV `auth:{token}`）；
2. 读记忆：KV `memory:cache` → 命中直接用；未命中回源 R2 `memory.md` 并写回 KV（TTL 24h）；
3. 读/生成当日上下文：R2 `context/YYYY-MM-DD.json` 存在则读，不存在则生成（日期、星期、节假日由内置表计算；天气走 Open-Meteo + KV 30min 缓存，失败降级为占位文本）；
4. 读最近 10 轮对话（D1，按 id 倒序取 20 条）；
5. 组装 system prompt → 调用 DeepSeek `/chat/completions`（`stream: true`）；
6. user 消息先写入 D1；assistant 回复随流边转发边累积，流结束后写入 D1；
7. DeepSeek 或天气异常时降级：user 消息已落库不丢失，前端收到错误提示。

#### B. 每日归档任务（/__cron/daily，20:00 UTC = 北京次日 04:00）

1. 幂等检查：`cron_runs` 中 `daily_archive/前一天` 已 done 则跳过；
2. 从 D1 读取**前一天**（已结束的完整自然日，如 10-22 04:00 归档 10-21）的全部消息；
3. 生成/复用当天 `context/YYYY-MM-DD.json`（含当天最终天气快照）；
4. 打包写入 R2 `chat_logs/YYYY-MM-DD.log`；
5. Workers AI 提炼当天对话要点 → 追加合并进 `memory.md`（条目带日期前缀）；
6. 大小维护：>12KB → 全量提炼压缩；仍 >15KB → 从最旧日期条目开始删除；
7. 刷新 KV `memory:cache`（新 TTL 24h）；
8. 写入 `cron_runs` 状态（成功/失败 + 详情）。

#### C. 月度合并任务（/__cron/monthly，每月 1 日 20:05 UTC = 北京 04:05）

1. 幂等检查（`monthly_merge/上月`）；
2. 列出 R2 `chat_logs/YYYY-MM-*.log`，按 id 排序去重合并为 `chat_logs/YYYY-MM.json`；
3. 校验合并产物消息数 ≥ 各单日文件之和（防丢失），通过后删除单日 .log；
4. D1 清理：删除 `date_key < 3 个月前` 的消息（此时早于该日期的数据必已归档）；
5. 写 `cron_runs`。

#### D. 记忆维护规则

- 提炼时新条目统一格式：`- [YYYY-MM-DD] 要点内容`，挂在对应主题小节下；
- 12KB 触发全量提炼：让 AI 在保留"事实/偏好/进行中事项"的前提下压缩；
- 提炼后仍 >15KB：从全文件最旧的 `[YYYY-MM-DD]` 条目整组删除，直到 ≤15KB（单条超长的先截断）。

### 1.8 API 设计

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/` | 聊天页面（静态资源） |
| POST | `/api/login` | 口令换 Token（Set-Cookie） |
| POST | `/api/logout` | 注销 |
| POST | `/api/chat` | 发送消息，返回 SSE 流 |
| GET | `/api/history?limit=20` | 最近消息（刷新页面后恢复） |
| GET | `/api/health` | 各资源连通性检查 |
| POST | `/api/admin/run-daily` | 手动触发每日归档（需口令） |
| POST | `/api/admin/run-monthly` | 手动触发月度合并（需口令） |
| GET | `/api/admin/stats` | D1 行数 / R2 体积 / 最近任务状态 |
| — | `/__cron/daily` `/__cron/monthly` | 仅 Cron 触发（校验 Cloudflare 触发头） |

### 1.9 关键设计决策与假设（请重点确认）

1. **"凌晨 4 点打包今天的记录"按"归档前一天"实现**：04:00 时"今天"几乎没有数据，所以归档的是刚结束的完整自然日（例：10-22 04:00 归档 10-21）。若你想按"4 点到次日 4 点"的滚动窗口归档，请告诉我。
2. **单日 .log 的内容是 JSON**（后缀仍叫 .log），与月度 JSON 合并逻辑一致。
3. **全系统统一北京时间**，Cron 按 UTC 配置（北京 04:00 = 20:00 UTC）。
4. **跨 0 点的对话会按消息自身日期拆进两天日志**（以消息的 `date_key` 为准），属预期行为。
5. **单用户为硬性约束**（用户明确确认）：不区分用户，永不添加多用户/注册功能；口令是唯一门禁，只存哈希。
6. **口令只存哈希**（Web Crypto SHA-256 + 随机盐），不存明文。

---

## 二、分阶段目标与任务

### 里程碑总览

| 阶段 | 内容 | 预估工作量 | 产出 |
|------|------|-----------|------|
| 阶段 0 | 脚手架与环境 | 0.5–1 天 | 可本地运行的空壳 Worker + 全部资源绑定 |
| 阶段 1 | 核心聊天链路 | 1–2 天 | 线上聊天页可用（MVP） |
| 阶段 2 | 每日归档 + 记忆提炼 | 1–2 天 | 记忆系统自动运转 |
| 阶段 3 | 月度合并 + 数据清理 | 0.5–1 天 | 归档体系闭环 |
| 阶段 4 | 打磨与运维 | 1 天+（持续） | 稳定运行 + 文档 |

---

### 阶段 0：项目脚手架与环境准备

**任务清单**

- T0.1 用 Wrangler 初始化 TypeScript Worker 项目（Hono），绑定 D1、R2、KV、Workers AI
- T0.2 创建 D1 数据库并建表（`messages`、`cron_runs`）
- T0.3 创建 R2 bucket，写入 `memory.md` 模板（含主题小节结构说明）
- T0.4 配置 Secrets：`DEEPSEEK_API_KEY`、`ACCESS_PASSWORD_HASH`；配置 vars：城市/经纬度、模型名、阈值（12KB/15KB）
- T0.5 内置 2026 年中国节假日调休表 JSON，实现节假日判断函数 + 单元测试
- T0.6 配置 `wrangler.toml`：cron `0 20 * * *`（每日）、`5 20 1 * *`（每月）；写好本地开发说明

**阶段目标**：本地 `wrangler dev` 能跑通 `/api/health`，所有绑定可用，节假日判断正确。

**验收标准**
- `/api/health` 返回 D1/R2/KV 连通状态；
- 节假日函数对 2026 年春节、国庆、调休上班日（如 9-27、10-10 等）判断正确；
- `wrangler deploy` 成功，线上 health 通过。

---

### 阶段 1：核心聊天链路（MVP）

**任务清单**

- T1.1 口令鉴权：`/api/login` 校验哈希 → 签发随机 Token 存 KV（7d）→ Set-Cookie；聊天接口 401 拦截
- T1.2 上下文组装器：KV 读记忆（miss 回源 R2 并写回）、生成/读取当日 context 文件、D1 取最近 10 轮
- T1.3 天气服务：Open-Meteo 调用 + KV 30min 缓存 + 失败降级占位文本
- T1.4 `/api/chat`：组装 system prompt → DeepSeek `stream:true` → SSE 转发；user 消息先落库、assistant 流结束后落库
- T1.5 聊天前端页面：消息列表、流式渲染、Markdown 渲染、发送框、登录页、最近历史恢复（`/api/history`）
- T1.6 部署到 Cloudflare，验证生产环境全链路

**阶段目标**：通过线上聊天页与 DeepSeek 正常对话（流式显示），消息成对落 D1，且 DeepSeek 能看到记忆与日期上下文。

**验收标准**
- 在 memory.md 写一段测试记忆，聊天中问 DeepSeek，它能复述；
- 回复逐字流式显示，刷新页面后历史可恢复；
- D1 中 user/assistant 成对出现，`date_key` 正确；
- 未登录访问聊天接口返回 401；天气接口挂掉时聊天仍可用。

---

### 阶段 2：每日归档与记忆提炼

**任务清单**

- T2.1 实现 `/__cron/daily`：`cron_runs` 幂等防重（同一天只跑一次）
- T2.2 打包前一天消息 + 当日上下文 + 天气快照 → R2 `chat_logs/YYYY-MM-DD.log`
- T2.3 Workers AI 提炼当天对话要点（写提炼 prompt）→ 按 `- [日期] 要点` 格式合并进 memory.md
- T2.4 大小维护：>12KB 全量提炼；仍 >15KB 从最旧日期条目删除
- T2.5 刷新 KV `memory:cache`（TTL 24h）
- T2.6 `/api/admin/run-daily` 手动触发接口（用于测试和补跑）

**阶段目标**：每天凌晨 4 点自动归档前一天对话、更新长期记忆，聊天读取到最新记忆。

**验收标准**
- 手动触发后 R2 出现当日 .log，内容完整（含上下文与全部消息）；
- memory.md 新增当日要点条目，KV 缓存已更新；
- 连续触发两次不会重复归档（幂等）；
- 构造 >12KB 的 memory.md 触发提炼，压缩后 ≤15KB，最旧条目被正确裁剪。

---

### 阶段 3：月度合并与数据清理

**任务清单**

- T3.1 实现 `/__cron/monthly`：合并上月 .log → `YYYY-MM.json`（按 id 排序去重）
- T3.2 合并完整性校验：产物消息数 ≥ 各单日文件之和，通过后才删除单日 .log
- T3.3 D1 清理：删除 3 个月前的消息（确认已归档后执行）
- T3.4 管理接口：`/api/admin/stats` 展示归档状态；`/api/admin/run-monthly` 手动触发

**阶段目标**：月度 JSON 自动生成，单日文件自动清理，D1 体积保持稳定，历史数据完整可追溯。

**验收标准**
- 模拟上月数据触发合并：生成 `2026-10.json` 内容完整，单日 .log 已删除；
- D1 中仅保留 3 个月内的消息；
- 合并过程中途失败不会丢数据（单日文件保留，可重跑）。

---

### 阶段 4：打磨与运维

**任务清单**

- T4.1 错误处理与降级复盘：DeepSeek/天气/Workers AI 失败时的兜底与重试策略；可选 webhook 告警通知
- T4.2 用量仪表：D1 行数、R2 体积、最近任务状态（`/api/admin/stats` 增强）
- T4.3 节假日表年度更新流程：文档化 + 次年表更新模板
- T4.4 前端体验优化：Enter 发送/Shift+Enter 换行、消息复制、重发、深色模式
- T4.5 README：本地开发、部署、密钥配置、目录约定、故障排查
- T4.6 网页端设置：城市可修改（用户指定需求；修改后当天上下文与天气随之生效）

**阶段目标**：系统长期稳定运行，日常维护有文档可循，异常可发现可恢复。

**验收标准**
- 断网模拟天气失败不影响聊天；DeepSeek 超时返回友好错误；
- 按 README 从零可完成全新部署；
- stats 页能看到各项用量与最近任务成败。

---

## 三、风险与注意事项

| 风险 | 说明与对策 |
|------|-----------|
| Cron 时区 | Cloudflare Cron 仅支持 UTC；北京 04:00 = 20:00 UTC，配置与文档均需标注 |
| 提炼质量 | 依赖 Workers AI 模型与 prompt；条目带日期前缀便于裁剪；失败重试 1 次并记录到 `cron_runs` |
| KV 最终一致性 | 每日任务刷新缓存后极短时间内可能读到旧记忆，影响可忽略（<60s） |
| Token 成本 | 每次请求携带 memory(≤12KB)+10 轮历史；12KB 阈值即为此成本权衡，可按实际账单调整 |
| DeepSeek 不可用 | user 消息先落库不丢失；前端显示错误，不吞消息 |
| 跨天对话拆分 | 按消息自身 `date_key` 归档，跨 0 点对话拆到两天日志，属预期行为 |
| 节假日表时效 | 每年 11–12 月更新次年国务院安排；表做成独立 JSON 便于替换 |
| Workers AI 免费额度 | 每日有 neurons 限额；提炼量小风险低，超限可换模型或调整执行时间 |
| 单日日志并发写 | 聊天写入 D1 与 04:00 归档存在微小窗口；归档按"已完成流"的数据读取，天然规避 |

## 四、确认结论（2026-10-21）

1. **归档口径已确认**：按自然日（00:00–23:59，北京时间）归档前一天；按自然日切割，D1 查询与跨天拆分最简单可靠。
2. **天气城市已确定**：北京（已写入 wrangler.toml）；后续在网页端提供修改入口（已加入阶段 4 任务 T4.6）。
3. **单用户为硬性约束**：永不添加多用户/注册功能，口令只存哈希。

## 五、变更与确认记录

| 日期 | 变更 |
|------|------|
| 2026-10-21 | 报告 v1.0 发布，10 个决策点全部确认 |
| 2026-10-21 | 用户确认：按自然日归档前一天；城市 = 北京；单用户硬性约束 |
