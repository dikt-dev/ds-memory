# 视频链路代码审查与优化清单

> 日期：2026-10-29  
> 范围：`ds-memory` Worker 的视频/GIF 相关代码；App 侧只列接口契约  
> 状态：只读审查，未改任何线上行为

---

## 0. 一句话

Worker 对视频的处理只有三行半：**收下来、存 R2、原样吐回去**。功能可用，但有 4 个真问题（其中 1 个是协议错误）和 5 个可以做的优化。

---

## 1. 现状盘点（代码位置）

| 环节 | 位置 | 实际行为 |
|---|---|---|
| 上传 | `index.ts:944-965` | 校验 content-type 头 → 限 60MB → 全量 `arrayBuffer()` → `R2.put` → 返回 key |
| 回放 | `index.ts:968-983` | 校验前缀 `videos/｜gifs/` → `R2.get` → 返回 body，带 `accept-ranges: bytes` |
| B 站预览 | `index.ts:757-938` | 只拿元数据 + 字幕 + 官方总结，**不返回任何帧信息** |
| 模型注入 | `openai.ts:713-777` | 只处理 `image_url`；视频本身从不发给模型 |
| 历史压缩 | `db.ts:240-254` | 只把 `[图片:images/…]` 缩成 `[图片]` |
| R2 清理 | `storage.ts:234-255` | **只清 `context/`**，videos/gifs/images/audio 永不清理 |
| 宫格/抽帧 | 无 | App 端自己调 `videoshot` 并解码（`BiliFrames.kt`），Worker 不知情 |

---

## 2. 问题（按严重度）

### 🔴 P0 · `/api/app/media` 声称支持 Range，实际不支持

```ts
// index.ts:975-981
return new Response(obj.body, {
  headers: { ..., 'accept-ranges': 'bytes', ... }
});
```

没有任何 `Range` 请求头解析、没有 206 响应、没有 `Content-Range`。

**后果**：播放器按"服务器支持断点"来决定是否边下边播。Android ExoPlayer 通常能容忍，但对 Safari/iOS 内嵌网页、以及任何严格客户端，**拖动进度条会从头开始**或直接失败。这个响应头是在说谎。

**修**：解析 `Range: bytes=a-b` → 用 R2 的 `range` 选项取子集 → 返回 206 + `Content-Range`；不支持时返回 416。

**收益**：播放器可 seek、可分段加载；60MB 视频首帧时间从"下完"变成"下 1 段"。

---

### 🟠 P1 · 视频占位符没被压缩，进了历史和记忆

`compactHistoryMessage` 只处理 `[图片:images/…]`（`db.ts:247`），`[视频:` / `[GIF:` 原样保留。

实际内容长这样：

```text
[视频:videos/2026-10-28/1c2f8a2e-....-....mp4]
```

**后果**：
- 50 轮历史里每条多约 50 字符；
- 每日提炼会把这段 UUID 路径当成正文读进 `memory.md`——不是"记忆变差"，是**记忆里出现垃圾**；
- `[GIF:]` 同理。

**修**：`db.ts` 的清洗链加两条正则，与 `[图片]` 对齐：

```ts
.replace(/\[视频:videos\/[^\]]+\]/g, '[视频]')
.replace(/\[GIF:gifs\/[^\]]+\]/g, '[GIF]')
```

**收益**：无风险；历史更省 token；提炼不再吸入路径噪声。**这条可以立刻做，但仍在观察期内，建议 11/02 后随批提交。**

---

### 🟠 P1 · R2 里的视频永远不会被删

`cleanupStaleObjects` 只遍历 `context/`（`storage.ts:243`）。`videos/`、`gifs/`、`images/`、`audio/` 没有任何 TTL。

**量级**：单视频上限 60MB，R2 免费额度 10GB ≈ **170 个 60MB 视频就打满**；正常日常使用（每月几十条短视频）大概 3–6 个月触顶。

**修**：两选一或并用——
1. 每日归档任务里加 `listKeys('videos/')` + 按 key 里的日期判断，超过 N 天删除（视频正文已被 D1 记住，删的是原始文件）；
2. 或改用 R2 生命周期规则（对象前缀 + 过期天数），不占 Worker 运行时间。

**收益**：成本可控；避免"用到一半才发现写不进去"。

---

### 🟡 P2 · 上传没有去重、没有流式、没有内容校验

`index.ts:955-963`：

- **无去重**：同一段视频重发两次（崩溃重试很常见）→ R2 存两份；
- **全量入内存**：60MB 文件 `arrayBuffer()` 至少占 60MB 堆，Worker 上限 128MB，并发两个就危险；
- **只信 content-type 头**：客户端声称 `video/mp4` 就能传任意字节。

**修**：
- 收尾时算 `sha256`（WebCrypto），先查 D1 的 `media_objects(hash, key)`，命中直接返回旧 key；
- 限制并发/大小（已有 60MB 上限，可降到 25MB 并给出提示）；
- 读前 12 字节验证 `ftyp` / `GIF89a` 魔数。

**收益**：省存储、降 OOM 风险、堵住"把 R2 当任意文件仓库"的口子。

---

### 🟡 P2 · 缓存策略浪费流量

`index.ts:980`：`cache-control: private, max-age=86400`，没有 `ETag`/`If-None-Match`。

视频是一次写入、永不修改的对象，应该是 `immutable` + 长缓存；现在每过 24 小时就要重下 60MB。

**收益**（估）：同一条视频反复回放，第二次起流量降为 0；对手机端是实打实的流量和电量。

---

### 🟡 P2 · 视频内容完全不进模型/记忆

现在模型对视频的全部认知就是 `[视频帧]` 这一个标记（`openai.ts:783`），或者由 App 临时上传的拼图（`#__transient`，不落库）。

**后果**：
- 同一个视频，重开对话就"忘了看过"；
- 记忆里没有任何视频语义，无法回答"上次那个视频讲什么来着"。

**修**：就是前面 `video-frame-proposal.md` 的宫格方案 + `media_sheets` 表。

---

### ⚪ P3 · B 站预览不返回帧信息

`link-preview` 返回 9 个字段，没有 `storyboard_url/cols/rows/index/cid/play_url`；而 App 的 `ApiClient.kt:844-849` 正在读这些字段——**死代码**。

**收益**：网页端第一次能显示视频帧；App 少一次自己调 `videoshot` 的往返。

---

## 3. 优化项汇总（含收益与成本）

| # | 优化 | 类型 | 收益 | 工作量 | 风险 |
|---|---|---|---|---|---|
| 1 | `/api/app/media` 实现 Range/206 | 修 bug | 可 seek、首帧更快、iOS 兼容 | 0.5 天 | 低 |
| 2 | 历史压缩补 `[视频]`/`[GIF]` | 修 bug | 省 token、清记忆噪声 | 0.5 小时 | 极低 |
| 3 | R2 视频 TTL 清理 | 运维 | 避免 10GB 打满 | 0.5 天 | 中（误删风险，需按日期前缀） |
| 4 | 上传 hash 去重 + 魔数校验 | 稳定性 | 省存储、降 OOM | 1 天 | 低 |
| 5 | 缓存改 immutable + ETag | 成本 | 重复回放流量→0 | 0.5 天 | 低 |
| 6 | B 站预览补 storyboard 字段 | 功能 | 网页有帧、App 少跳 | 0.5 天 | 极低 |
| 7 | 端上宫格 + 服务端存图 | 功能 | 模型能"看"视频、可引用第 k 格 | 3–4 天 | 中 |
| 8 | `media_sheets` 元记忆 | 功能 | 跨会话记得"看过" | 1 天 | 低 |

**优先级建议**：`2 → 1 → 6 → 3 → 5 → 4 → 7 → 8`

前两项是纯修 bug、零产品决策，加起来不到一天；6 是纯透传；3/5 是账单和流量；7/8 才是新功能。

---

## 4. 时间安排（受观察期约束）

```text
现在–11/01 21:10   只记录，不动代码（观察期冻结）
11/02             出 Phase 5 报告
11/03             #2 占位符压缩 + #1 Range（一起提交，半天）
11/04             #6 透传字段 + #5 缓存头（半天）
11/05             #3 TTL 清理（先 dry-run 列出将删的 key）
11/06+            #4 去重校验 → #7 宫格 → #8 元记忆
```

---

## 5. 我没做的验证

- 没测真实设备上的 Range 行为（推断依据是 HTTP 语义，不是实测）；
- 没查 R2 当前 `videos/` 的实际占用（需要 `list` 全量遍历，建议单独跑一次）；
- 没看 App 侧的上传实现细节（只看了接口调用点）。
---

## 6. 进度（2026-10-29 更新）

### ✅ 已完成并提交

| # | 项 | 提交 | 状态 |
|---|---|---|---|
| 1 | `/api/app/media` 支持 Range/206/416 + ETag 304 + immutable | `c3ce525` | 代码+测试完成，**未部署** |
| 2 | `[视频]`/`[GIF]`/`[语音]` 占位符压成标记（历史 + 提炼共用） | `c3ce525` | 同上 |
| 2b | 提炼输入走同一份清洗（此前 `[图片:images/…]` 会进 memory.md） | `c3ce525` | 同上 |
| 9 | App：宫格按 `index[]` 裁剪真实帧 + 每格标时间 | `ds-mobile` 提交 | 已装真机，待真实视频复验 |

测试：`tsc` 0 错；vitest **62 文件 / 733 用例**全过（新增 `parseByteRange`、`sanitizeMessagePlaceholders` 两组）。

### ⏸ 现在做不了的（记录在此）

| # | 项 | 卡在哪 |
|---|---|---|
| 3 | R2 视频 TTL 清理 | 需要先知道 `videos/` 实际占用；主桶没有 S3 凭据，`wrangler r2 object list` 在 v4.151 不可用。等 11/02 用 admin 接口或补 S3 key |
| 4 | 上传 hash 去重 + 魔数校验 | 需要改上传协议（App 同时改），排到 11/06 之后 |
| 5 | 缓存头改 immutable | 已随 #1 完成（`max-age=31536000, immutable`） |
| 6 | Worker 侧 `link-preview` 透传 storyboard 字段 | 网页端需要；App 不依赖（自己调 videoshot）。观察期结束后再做 |
| 7 | 宫格图持久化（跨会话/网页可回放） | 目前走 `#__transient`，不落 R2；要不要存是产品决定 |
| 8 | `media_sheets` 元记忆 | 依赖 #7 |
| — | 真机验证宫格效果 | 需要发一条真实 B 站链接，会写入真实对话/记忆，等用户确认后再做 |
| — | Worker 部署 | 观察期冻结，11/02 之后 |

### 部署清单（11/02 后一条命令）

```bash
node node_modules/wrangler/bin/wrangler.js deploy --config wrangler.local.toml \
  --var MEMORY_ENGINE_QQ:shadow --var AFFECT_ENGINE_QQ:shadow \
  --var MEMORY_ENGINE_WEB:legacy --var AFFECT_ENGINE_WEB:legacy \
  --var MEMORY_ENGINE_MOBILE:shadow --var AFFECT_ENGINE_MOBILE:shadow \
  --var PROACTIVE_ENGINE:shadow --var PROACTIVE_DELIVERY:queue
```

部署内容仅：Range 支持 + 占位符清洗，不涉及引擎 flag、不改检索路径。
---

## 7. 2026-10-29 执行记录

### 已上线

| 项 | 内容 | 证据 |
|---|---|---|
| Worker 部署 | Range/206/416 + ETag + immutable 缓存 + 占位符清洗 | 版本 `e7f6557e`，health 200，引擎 flag 未变 |
| 删除 secret | `BILIBILI_SESSDATA` 已删除（App 内有 933 字符完整 cookie，Worker 那份是冗余且失效的路径） | `wrangler secret list` 已无该项 |
| App | 只发一张宫格；Meta 说明编号/时间语义；无字幕时要求不编造台词 | `0408af4` |

### 「模型把九宫格当普通图片」的根因与修复

线上回复里出现过：

```text
（把手机举起来，一张一张划过去）……后面这几张是啥，同一张图来回换？
```

根因不是模型笨，是**输入本身有问题**：

1. App 以前发 **3 张图**：宫格 + 2 张"关键帧"；
2. 那 2 张关键帧是 `decodeRegion` 出来的**同一批位图**，分辨率和宫格格子完全相同，
   对模型来说是"同一张图的重复"；
3. 三张图没有任何文字说明它们是什么关系 → 模型只能猜，于是描述成"同一张图来回换"。

修复：

- 只发 1 张宫格（关键帧本来就是格子里的像素，重复发还多花 2×384 token）；
- Meta 里写明"3×3 共 9 格，左上→右下编号，格号下方是时间点，引用时写「第 5 格（约 16:44）」"；
- 明确"格号和时间是定位标记，不是画面内容"。

顺带收益：一次 B 站视频的图片 token 从 **1152（3 张）降到 384（1 张）**。

### 仍未做

- ~~R2 `videos/` TTL 清理~~ → **2026-10-29 实测不必要**，见下方占用快照
- 上传 hash 去重 + 魔数校验
- Worker 侧 `link-preview` 透传 storyboard 字段（网页端用；App 不依赖）
- `media_sheets` 元记忆（宫格目前 `#__transient`，不落库）
- **竖屏视频比例**：宫格固定 720×405，竖屏会被拉伸，需要按源比例算画布
### R2 占用快照（2026-10-29，S3 API 只读统计）

| 前缀 | 对象数 | 大小 | 最早 | 最新 |
|---|---|---|---|---|
| **合计** | **49** | **18.1 MB** | 2026-10-24 | 2026-10-29 |
| `videos/` | 1 | 0.5 MB | 10-25 | 10-25 |
| `gifs/` | 3 | 3.4 MB | 10-25 | 10-26 |
| `images/` | 27 | 12.7 MB | 10-24 | 10-28 |
| `audio/` | 3 | 0.4 MB | 10-25 | 10-27 |
| `chat_logs/` | 6 | 1.0 MB | 10-24 | 10-28 |
| `context/` | 7 | ~0 MB | 10-24 | 10-29 |

结论：

- 10 GB 免费额度用了 **0.18%**；按 `images/` 约 2.5 MB/天外推，一年约 0.9 GB，**短期不需要 TTL**。
- 真要上 TTL 也得先解决引用：消息里的 `[图片:images/…]` 会变死链。
- 更值得做的是**上传去重**：27 张图 12.7 MB，同图重复上传会线性膨胀。

统计方式（可复用）：S3 `ListObjectsV2`，URL 必须是
`https://<acct>.r2.cloudflarestorage.com/<bucket>?list-type=2&prefix=…` ——
前缀放 **query** 里；放进 path 会被当成对象 key，返回 `NoSuchKey`。