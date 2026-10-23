# 角色名由 CHARACTER_NAME 环境变量决定（缺省「小忆」）· 项目结构与流程总结

> 版本 v3.0（messages 表重构后）｜2026-10-22
> 线上：https://your-worker.example.com ｜ 仓库：https://github.com/dikt-dev/ds-memory

---

## 一、项目定位

部署在 Cloudflare 上的**带长期记忆的私人 AI 聊天代理**。核心价值：

1. **跨天记忆**：每天把对话提炼进 `memory.md`，聊天时自动注入，AI 记得你
2. **环境感知**：每次对话都带上时间、日期、节假日、天气
3. **关系演化**：好感度/亲密度缓慢变化，AI 的态度随之调整
4. **主动聊天**：AI 会按随机时间主动开口（不需要你先说话）
5. **全云端**：不需要服务器、不需要公网 IP、不需要常驻进程

---

## 二、技术栈

| 层 | 选型 | 用途 |
|----|------|------|
| 运行时 | Cloudflare Workers + Hono | 路由、SSE 流式转发、定时任务 |
| 数据库 | D1（SQLite） | 消息、任务状态、主动消息记录、外发队列 |
| 对象存储 | R2（主账号 + 小号双桶） | memory.md、每日上下文、归档日志、图片 |
| 缓存 | KV | 记忆缓存、今日摘要、天气、会话、存储模式 |
| AI | DeepSeek API（flash / v4-pro） | 对话与提炼 |
| AI 兜底 | Workers AI | DeepSeek 失败时的提炼兜底 |
| 前端 | 原生 HTML/CSS/JS 单页 | 零构建，Worker 静态托管 |

---

## 三、数据模型（v2 重构后）

### 3.1 `messages` —— 消息表（核心）

```sql
CREATE TABLE messages (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  role              TEXT NOT NULL,          -- 'user' | 'assistant'
  content           TEXT NOT NULL,          -- 正文（图片存 [图片:images/…] 标记）

  -- 轮次关系（本次重构的重点）
  turn_id           INTEGER NOT NULL,       -- 一轮对话的标识
  turn_type         TEXT NOT NULL DEFAULT 'chat',  -- 'chat' | 'proactive'
  reply_to_id       INTEGER,                -- 助手回复用户时指向 user 消息；主动消息为 NULL

  -- 来源与场景
  channel           TEXT NOT NULL DEFAULT 'web',   -- web/astrobot/mobile/desktop/pet
  proactive_kind    TEXT,                   -- morning/evening/random（仅主动消息）

  -- 计费与用量
  cost_rmb          REAL NOT NULL DEFAULT 0,
  prompt_tokens     INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,

  -- 时间
  date_key          TEXT NOT NULL,          -- 北京时间 YYYY-MM-DD（归档依据）
  created_at        TEXT NOT NULL,          -- ISO8601
  created_ms        INTEGER NOT NULL        -- epoch 毫秒（排序/算间隔）
);
```

**两种消息形态：**

| 场景 | user 行 | assistant 行 |
|------|---------|--------------|
| 用户发起对话 | `turn_id=自己id`, `reply_to_id=NULL` | `turn_id=user的id`, `reply_to_id=user的id` |
| **AI 主动消息** | **无** | `turn_id=自己id`, `turn_type='proactive'`, `reply_to_id=NULL` |

> 这样设计的好处：任意一行都能通过 `turn_id` 找到同轮消息；用 `turn_type` 区分来源；用 `reply_to_id` 表达"谁回复谁"。

### 3.2 `cron_runs` —— 定时任务幂等

```sql
job_type TEXT,   -- daily_archive | monthly_merge
target   TEXT,   -- YYYY-MM-DD 或 YYYY-MM
status   TEXT,   -- running | done | failed
detail   TEXT,   -- 执行摘要（条数/记忆大小/费用）
UNIQUE(job_type, target)  -- 同一天/月只跑一次
```

作用：防重复执行、失败自动补跑、卡死接管（running 超 2 小时）。

### 3.3 `proactive_log` —— 主动消息记录（v2 新增）

```sql
date_key   TEXT,   -- YYYY-MM-DD
slot_key   TEXT,   -- morning | evening | random-0 | random-1
kind       TEXT,   -- morning | evening | random
message_id INTEGER,-- 关联 messages.id
status     TEXT,   -- sent | failed
UNIQUE(date_key, slot_key)  -- ★ 数据库级幂等
```

> **为什么用表而不是 KV**：KV 是最终一致性的，写入后各边缘节点有延迟，可能导致同一时段重复发送。D1 的唯一约束是强一致的。

### 3.4 `proactive_queue` —— 外发队列（AstrBot 反向轮询用）

```sql
content    TEXT,
sent_at    TEXT,     -- NULL = 待发送
attempts   INTEGER,  -- 失败重试计数（5 次后放弃）
message_id INTEGER   -- 关联 messages.id
```

---

## 四、R2 / KV 存储结构

### R2（双账号，主账号达 8.5GB 自动切小号）

```
R2 根目录/
├── memory.md                    # 长期记忆核心（≤12KB 稳态，超 6.5KB 开始分层）
├── memory/
│   └── archive.md               # 长期档案：核心层溢出的旧条目（只搬不删，按需检索）
├── context/
│   └── 2026-10-22.json          # 当天上下文（日期/节假日/天气/关系状态/提炼摘要）
├── chat_logs/
│   ├── 2026-10-22.log           # 单日归档（JSON）
│   └── 2026-10.json             # 月度归档（月末合并后删单日文件）
└── images/
    └── 2026-10-22/
        └── 1792630016123.jpg    # 聊天图片（时间戳命名）
```

> 归档清理：`cleanupStaleObjects` 定期清理过期的 context / images，
> 但 `chat_logs/`、`memory.md`、`memory/archive.md` 永不清除。

### KV

| 键 | TTL | 用途 |
|----|-----|------|
| `memory:cache` | 24h | memory.md 缓存（归档后强制刷新） |
| `summary:日期` | 36h | 当日滚动摘要（每 20 条或 2 小时更新） |
| `summary:lock:日期` | 2min | 摘要生成锁 |
| `memo:24h` | 48h | 中期记忆：最近 24 小时纪要 |
| `memo:lock` | 2min | 中期纪要生成锁 |
| `weather:城市` | 30min | 天气缓存 |
| `config:city` | 永久 | 城市配置 |
| `auth:token` | 7天 | 登录会话 |
| `login:fail:IP` | 10min | 登录失败限流计数 |
| `storage:mode` | 永久 | main / secondary（存储切换） |
| `storage:usage` | 短期 | 主账号 R2 用量估算 |
| `relation:active_days` | **永久** | 累计有效聊天天数（决定亲密度上限，不能丢） |
| `session:mood` | 2h | 会话级情绪残留（约 12 分钟指数衰减） |
| `mood:drift:日期` | 2天 | 当日已用掉的环境心情漂移额度 |
| `mood:ai:文本` | 6h | 情绪 AI 复核结果缓存 |
| `profile:user` | 6h | 用户活跃画像缓存 |
| `profile:dirty` | 24h | 用户画像待重算标记 |
| `aversion:candidates` | 30天 | 雷区候选池（累计到阈值后提升入 memory.md） |
| `archive:cache` | 短期 | 记忆档案检索缓存 |

> 主动消息的幂等**不再依赖 KV**：KV 是最终一致的，写入后各边缘节点有延迟，
> 可能导致同一时段重复发送。现在改用 D1 `proactive_log` 的 `UNIQUE(date_key, slot_key)`，
> 强一致、不会重复。（历史文档里的 `proactive:sent:*` 键已废弃。）

---

## 五、核心流程

### 5.1 用户发消息（网页）

```
用户输入 → POST /api/chat
    ↓
① 鉴权（Cookie → KV）
② 组装上下文：
   - memory.md（KV→R2 兜底）
   - 当天 context（日期/星期/节假日/天气）
   - 今日摘要（KV）
   - 最近 20 条消息（D1）
   - 关系态度（好感度/亲密度 → 阶段 → 5×5 矩阵）
③ 落 user 消息（D1，带 channel）
④ 调 DeepSeek（流式，thinking=disabled）
⑤ SSE 透传前端 + 累积回复
⑥ 流结束：落 assistant 消息 + 计费（费用+token）
⑦ 异步：检查是否需要生成今日摘要
```

### 5.2 用户发消息（AstrBot / 其他客户端）

```
POST /v1/chat/completions（Bearer 鉴权）
    ↓
① 解析 OpenAI 格式消息（支持文本+图片数组）
② 清洗 AstrBot 的 <system_reminder> 和 [Image N: ...] 内部路径
③ 图片：压缩存 R2 → 从 R2 读回 base64 → 发给 DeepSeek
④ 组装上下文（同上，但历史由调用方提供，只注入记忆+当天信息）
⑤ 落 user 消息（channel=astrobot，增量去重）
⑥ 流式/非流式返回 + 落 assistant + 计费
```

### 5.3 AI 主动消息（本次重构重点）

```
cron 每 5 分钟
    ↓
① 判断时机：
   - 固定时段：07:45-08:15（morning）、22:45-23:15（evening）
   - 随机时段：09:00-22:30 内，每天随机 0~2 条
② 数据库级幂等：INSERT proactive_log（UNIQUE 冲突 = 已发过）
③ 组装上下文（记忆/当天/天气/态度/最近对话/最近主动消息）
④ 用「模拟用户消息」请求 DeepSeek ← 这条不入库
⑤ DeepSeek 回复 → 写入 messages（turn_type='proactive'）
⑥ 回填 proactive_log（message_id + status）
    ↓
用户打开网页 → 看到 AI 主动说的话
```

**时间随机规则**：
- 第 1 条限制在窗口前 55%（约 09:00–16:30），避免随机到太晚
- 第 2 条与第 1 条间隔 ≥ 90 分钟，放不下则当天只发 1 条
- 同一天结果固定（日期作种子），不同天随机浮动

### 5.4 每日归档（04:00 北京时间 = 20:00 UTC）

```
cron "0 20 * * *"
    ↓
① 容量检查：主账号 R2 用量 ≥ 8.5GB → 切小号
② 补跑历史失败日期（最旧优先，≤7 个）
③ 归档前一天：
   - 取当天全部消息（D1）
   - 取/生成当天 context（含天气快照）
   - 写 R2 chat_logs/日期.log（消息 + 上下文）
   - DeepSeek 提炼（v4-pro）→ 合并进 memory.md
   - 提炼结果写回 context/日期.json
   - 关系状态写入 context
   - 大小维护：>12KB 压缩，仍 >15KB 删最旧
   - 写回 R2 + 强制刷新 KV 缓存
   - 清理当日滚动摘要
④ 记录 cron_runs
```

### 5.5 月度合并（每月 1 日）

```
① 补跑失败月份
② 检查当月缺失日期 → 缺的先补归档
③ 仍缺 → 拒绝合并（防丢数据）
④ 合并单日 .log → 月度 .json（按 id 去重）
⑤ 完整性校验 + 回读校验
⑥ 校验通过后删除单日文件
⑦ D1 清理：只删「已成功合并且超 3 个月」的数据
```

### 5.6 每 8 小时 context 刷新

```
北京 08:00 / 16:00 / 24:00
    ↓
① 拉最新天气 → 写 context
② 从 memory.md 读好感度/亲密度 → 算阶段与态度 → 写 context
```

---

## 六、记忆体系（四层）

按时间尺度分四层（README 有完整说明）：

| 层级 | 内容 | 存储 | 生命周期 | 注入方式 |
|------|------|------|---------|---------|
| **长期核心** | 人物底色、称呼与关系、长期记忆、偏好、进行中事项、共同经历、雷区、近期动态 | R2 `memory.md`（≤6.5KB 核心） | 每日归档维护，受保护分区不自动删 | 每轮全文注入 |
| **长期档案** | 核心溢出后「只搬不删」的旧条目，带 `#标签` | R2 `memory/archive.md` | 永久 | **按需检索**，命中最多 4 条 |
| **中期** | 最近 24 小时的电报体纪要（3~6 条） | KV `memo:24h` | 3 小时或每 15 条消息滚动刷新 | 每轮注入（存在时替代今日摘要） |
| **短期** | 最近 20 条原文 | D1 | 滚动 | 每轮 |

> 另有「今日摘要」（KV `summary:日期`，100 字速写，TTL 36h）作为中期记忆的兜底：
> 中期纪要存在时不注入，避免同一段内容发两遍。

**保护机制**：
- 人物底色：提炼时忽略、压缩时取出放回、裁剪时跳过（三重保护）
- 好感度/亲密度：0~1000 边界、替换（不追加）而非叠加
  - 好感度：由互动「质量」驱动（温暖/感谢/冒犯/冲突），单日升降均 ≤5
  - 亲密度：由互动「量」驱动（轮次/连续天数/新增记忆），
    单日涨幅 ≤4，并受「累计有效聊天天数」硬上限约束：`300 + 天数 × 2`（封顶 1000）
    已到上限后仍给 +1/天的「宽恕增长」，不会彻底卡死
  - 心情值：由 AI 提议 + 环境漂移驱动，两者各自受 ±80 约束
- **天数不会倒退**：累计聊天天数持久化在 KV（`relation:active_days`）并与 D1 取较大值，
  因此月度归档清理 D1 不会导致亲密度上限回落（历史 D1 全表统计会有此问题）

---

## 七、API 一览

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| GET | `/` | - | 聊天页面 |
| GET | `/api/health` | - | 资源连通性 |
| GET | `/api/day` | - | 当天上下文（含天气） |
| POST | `/api/login` | - | 口令登录 |
| POST | `/api/logout` | - | 退出 |
| POST | `/api/chat` | Cookie | 聊天（SSE，支持图片/渠道） |
| GET | `/api/history` | Cookie | 历史分页 |
| GET | `/api/history/since` | Cookie | 增量拉取（前端轮询实时刷新） |
| GET | `/api/usage` | Cookie | 计费统计 |
| GET | `/api/balance` | Cookie | DeepSeek 余额 |
| GET/POST | `/api/settings`、`/api/admin/settings` | -/Cookie | 城市配置 |
| POST | `/api/admin/run-daily` | Cookie | 手动归档 |
| POST | `/api/admin/run-monthly` | Cookie | 手动月度合并 |
| POST | `/api/admin/run-context` | Cookie | 手动刷新 context（天气/心情/关系快照） |
| POST | `/api/admin/test-mood` | Cookie | 情绪识别链路自检 |
| POST | `/api/admin/trigger-proactive` | Cookie | 手动触发主动消息 |
| GET | `/api/admin/stats` | Cookie | 系统统计（含分层记忆指标） |
| GET | `/api/image/*` | Cookie | 图片回放 |
| GET/POST | `/v1/models`、`/v1/chat/completions` | Bearer | OpenAI 兼容端点 |
| GET/POST | `/api/proactive/pending`、`/api/proactive/ack`、`/api/proactive/nack` | Bearer | 主动消息队列（拉取/回执/失败上报） |
| GET | `/api/proactive/stats` | Cookie | 主动消息队列状态 |

---

## 八、定时任务

| cron（UTC） | 北京时间 | 内容 |
|-------------|---------|------|
| `0 20 * * *` | 04:00 | 每日归档（每月 1 日加月度合并） |
| `*/5 1-14 * * *` | 09:00-22:30 每 5 分钟 | 随机主动消息（含 UTC 8 点 → 北京 16:00 的 context 刷新） |
| `*/5 23,0,14,15,16 * * *` | 07:45-08:15 / 22:45-23:15 每 5 分钟 | 早晚固定主动消息 + context 刷新（北京 08:00 / 16:00 / 24:00） |

> Cloudflare 免费版限制 3 个 cron，故合并分发。context 刷新只在 UTC 0 / 8 / 16 点整的前 5 分钟内执行
> （`maybeRefreshContext` 按 `getUTCMinutes() < 5` 过滤，其余 tick 直接返回）。

---

## 九、计费

- **聊天**：`deepseek-flash`（高峰 0.04/2.0/8.0 元每百万 tokens，闲时减半）
- **提炼/压缩**：`deepseek-v4-pro`（0.30/9.0/27.0，质量优先）
- **滚动摘要**：`deepseek-flash`
- **高峰判定**：北京时间工作日 9-12、14-18；周末与法定节假日全天闲时
- 页面显示：今日费用、7 天费用、每条回复费用、账户余额

---

## 十、本次重构解决的问题

| # | 旧问题 | 新方案 |
|---|--------|--------|
| 1 | `pair_id` 语义混乱（自引用/外键/NULL 三种含义） | `turn_id` + `turn_type` + `reply_to_id` 三个字段各司其职 |
| 2 | 无法区分"用户发了但 AI 未回复"与"AI 主动发起" | `turn_type='proactive'` 明确标记 |
| 3 | 渠道信息只在提示词里，数据查不到 | `channel` 落库并建索引 |
| 4 | 不知道主动消息是早间/深夜/随机 | `proactive_kind` 字段 |
| 5 | 幂等依赖 KV（最终一致，可能重复发送） | `proactive_log` 数据库唯一约束 |
| 6 | 只有费用，无 token 明细 | `prompt_tokens` / `completion_tokens` |
| 7 | 时间间隔计算要解析字符串 | `created_ms` 整数时间戳 |
| 8 | 外部推送通道和网页端重复写 D1 | 推送通道只推送不落库，网页端统一落库 |

---

## 十一、目录结构

```
ds_memory/
├── src/
│   ├── index.ts            # Worker 入口：路由 + cron 分发
│   ├── types.ts            # 环境变量与绑定类型
│   ├── date.ts             # 北京时间工具
│   ├── auth.ts             # 口令哈希
│   ├── settings.ts         # 城市配置
│   ├── storage.ts          # 双账号 R2 抽象层
│   ├── db.ts               # D1 消息存取（v2 结构）
│   ├── context.ts          # 当天上下文文件（日期/天气/关系快照）
│   ├── holidays.ts         # 中国节假日（2026 官方表）
│   ├── weather.ts          # 天气（Open-Meteo）
│   ├── media.ts            # 图片压缩与存储
│   ├── pricing.ts          # 计费
│   ├── llm-cost.ts         # 提炼/摘要等非聊天调用记账
│   │
│   ├── deepseek.ts         # DeepSeek 调用核心（流式/非流式）
│   ├── prompt.ts           # 系统提示词组装 + 渠道定义
│   ├── chat.ts             # 网页聊天链路
│   ├── openai.ts           # OpenAI 兼容端点（AstrBot）
│   │
│   ├── memory.ts           # memory.md 读写（R2+KV）
│   ├── memory-maintenance.ts # 记忆合并/压缩/裁剪/分区配额/关系变量
│   ├── memory-archive.ts   # 长期档案 + 按需检索（同义词/标签/区分度）
│   ├── recent-memory.ts    # 中期记忆：最近 24 小时纪要
│   ├── summary.ts          # 当日滚动摘要（中期记忆的兜底）
│   ├── distill.ts          # 提炼与压缩（DeepSeek 优先，AI 兜底）
│   ├── aversion.ts         # 雷区与禁忌的主动学习
│   │
│   ├── jobs.ts             # 每日归档 + 月度合并 + context 刷新
│   ├── proactive.ts        # 主动消息时间规则 + 投递通道
│   ├── proactive-engine.ts # 主动消息打分决策（纯函数）
│   ├── webproactive.ts     # AI 主动消息主流程（落 D1 + 入队）
│   ├── queue.ts            # 主动消息外发队列
│   ├── profile-cache.ts    # 用户活跃画像缓存
│   ├── feedback.ts         # 主动消息质量反馈
│   ├── milestone.ts        # 里程碑（认识天数/连续聊天）
│   │
│   ├── attitude.ts         # 好感度/亲密度阶段与态度矩阵
│   ├── relation-drivers.ts # 好感度/亲密度驱动信号
│   ├── relation-store.ts   # 累计聊天天数持久化（KV，防 D1 清理导致上限倒退）
│   ├── relation-growth.ts  # 渐进增长模型
│   ├── relation-stats.ts   # 当日关系统计（从 D1 汇总）
│   ├── mood.ts             # 情绪感知（关键词）
│   ├── mood-ai.ts          # 情绪识别 AI 复核 + 合并
│   ├── mood-env.ts         # 心情的环境漂移
│   │
│   ├── character-card.ts   # 活人感：角色状态卡
│   ├── voice.ts            # 活人感：语言层（禁用词/口语化）
│   ├── anti-ai-flavor.ts   # 活人感：AI 味兜底清洗
│   ├── session-state.ts    # 活人感：会话级情绪残留
│   ├── session-facts.ts    # 活人感：状态数据采集
│   ├── identity.ts         # 角色名/称呼解析（CHARACTER_NAME / USER_ADDRESS）
│   ├── vendor.d.ts         # 第三方模块类型声明
│   └── *.test.ts           # 单元测试（32 个，与模块同名）
├── public/
│   ├── index.html          # 聊天页面
│   ├── avatar.png          # 助手头像
│   └── user-avatar.png     # 用户头像
├── astrbot-plugin/         # AstrBot 反向轮询插件（主动消息推送）
├── astrbot-plugin-file/    # AstrBot 文件读取插件
├── docs/
│   └── liveliness-plan.md  # 活人感改造计划与三通道覆盖基线
├── scripts/                # 口令哈希、本地试聊、聊天记录提取
├── schema.sql              # D1 表结构
├── memory-template.md      # 首次部署写入 R2 的 memory.md 模板
├── wrangler.toml           # 部署配置
└── README.md               # 使用文档
```

---

## 十二、关键设计决策

1. **自然日归档**：按北京时间 00:00–23:59 切割，D1 查询简单、不重不漏
2. **04:00 归档前一天**：04:00 时"今天"几乎没有数据，归档刚结束的完整自然日
3. **数据库级幂等**：所有定时任务和主动消息都用 D1 唯一约束，不依赖 KV
4. **失败可恢复**：`cron_runs.status='failed'` 的任务下次自动补跑
5. **绝不静默丢数据**：月度合并前检查缺失日期，补不齐就拒绝合并
6. **降级不阻断**：记忆/天气/提炼失败都不影响聊天主流程
7. **图片双轨**：R2 存文件（供回放），base64 传 DeepSeek（供理解）
8. **单用户硬约束**：永不添加多用户/注册功能，口令只存哈希

---

> 本文档随代码演进；新增模块（分层记忆、活人感、主动消息引擎…）后请同步更新「十一、目录结构」与 README 的目录结构。
