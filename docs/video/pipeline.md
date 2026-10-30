# 视频链路：设计、评审与 B 站摘要诊断

> 本文件合并抽帧方案、代码评审与官方摘要/字幕诊断（2026-10-30 整理）。

<!-- merged from: video-frame-proposal.md -->

## 视频宫格（storyboard）能力方案 v2 · 客户端优先

> 状态：**提案，待评审**，不动线上  
> 变更：v1 把合成放在 Worker，需要赌 CPU 预算；v2 把重活全部挪到端上，Worker 只做存储/协议/代理  
> 参考：[dsh-video-storyboard](https://github.com/SAOS-3624/dsh-video-storyboard)（MIT，v0.4.3）

---

### 1. 结论

**可以放到 App 上，而且这样更对。**

Worker 侧的新增成本 = 一次 R2 put + 几百字节 JSON，CPU 增量≈0；不碰图片解码，不碰 jpeg 编码，不碰像素合成。

这样做的三个前提，我们的代码里都已经具备：

| 前提 | 证据 |
|---|---|
| App 已经能拿到并解码雪碧图 | `BiliFrames.kt:202-210`（`BitmapFactory` 整张解码，注释明确"不再裁成 3×3"） |
| App 已经有上传通道 | `ApiClient.kt:791` `/api/app/upload/video`；同族还有图片上传 |
| Worker 已经能把 R2 图片注入对话 | `media.ts:231-240` `loadImageDataUrl()` → base64 → DeepSeek |

也就是说：**App 负责"看得见"，Worker 负责"记得住"**。

---

### 2. 分工

| 环节 | 谁做 | CPU/成本 |
|---|---|---|
| 取雪碧图（带 Referer/Cookie） | App（已有） | 手机流量，无服务端成本 |
| 选哪几格（按 `index[]` + 字幕密度） | 端上执行；算法也可由 Worker 给（纯算术） | 微秒级 |
| 裁切 + 拼 3×3 + 烧编号 | **端上**（Android Canvas / 浏览器 Canvas） | 几十毫秒，本地 |
| 编码 JPEG | **端上** `Bitmap.compress` / `canvas.toBlob` | 同上 |
| 存 R2 | Worker：收字节 → `R2.put` | ≈0（与现有 upload/video 同量级） |
| 记元数据（格子时间戳、来源 bvid） | Worker：D1 一行 | ≈0 |
| 回放 / 注入模型 | Worker：现有 `loadImageDataUrl` 路径 | 现状已有 |
| 网页端 | 需要 Worker 代理雪碧图字节（见 §5） | 流式转发，≈0 |

---

### 3. 接口（Worker 只加三个轻端点）

#### 3.1 `GET /api/app/sprite?bvid=...` — 代理雪碧图字节

给网页端用（原因见 §5）。App 可不用（它自己带 Cookie 直连更快）。

```text
→ 流式返回 image/jpeg（或 302 到 i0.hdslb.com）
→ 响应头 X-Storyboard-Cols / X-Storyboard-Rows / X-Storyboard-Index(JSON)
```

CPU：纯转发，不做像素运算。可加 1 天 R2 缓存。

#### 3.2 `POST /api/app/sheet` — 接收端上合成好的图

```json
{
  "bvid": "BV1xx",
  "cols": 3, "rows": 3,
  "cells": [{ "n": 1, "t": 0 }, { "n": 2, "t": 30 }],
  "duration": 300,
  "source": "storyboard",
  "image": "<base64 jpeg>"
}
```

→ 存 `sheets/` + 日期 + `sha256(图).jpg` → 返回 `{ key, tokens: 384 }`

**去重**：同 hash 直接返回已有 key，同一视频反复上传不重复占空间。

#### 3.3 `link-preview` 补字段（透传，向后兼容）

```json
{ "storyboard_url": "...", "storyboard_cols": 10, "storyboard_rows": 10,
  "storyboard_index": [0, 1.2, ...], "cid": 123, "play_url": "..." }
```

App 的 `ApiClient.kt:844-849` 早就在读这几个字段，现在是死代码。

---

### 4. 端上算法（这才是"怎么做更好"的核心）

#### 4.1 选格：按字幕密度，不按均匀间隔

`index[]` 给了每帧的秒数，字幕给了每句时间。做法：

```text
1. 时间轴切成 N×3 个候选窗口
2. 每窗口权重 = 台词字数 / 窗口时长（信息密度）
3. "积分等分"选出 N 格：让每格承载的台词量大致相等
4. 约束：格间最小间隔 ≥ 总时长 × 0.15；首尾各留 5%
```

方法借自 storyboard 的 `density.js`（它按剪辑率积分，我们按台词密度积分），不是抄代码。

#### 4.2 格数

| 时长 | 有字幕 | 无字幕 |
|---|---|---|
| < 90s | 4 格（2×2） | 6 格 |
| 90s–10min | 6 或 9 格 | 9 格 |
| > 10min | 9 格 + 注明"只覆盖前 10 分钟" | 12 格 |

上限 9 格：一张图 384 token，12 格以上边际收益递减，手机上拼图也会糊。

#### 4.3 合成（约 40 行）

```kotlin
val cellW = sprite.width / cols
val cellH = sprite.height / rows
val out = Bitmap.createBitmap(sheetW, sheetH, ARGB_8888)
val canvas = Canvas(out)
picked.forEachIndexed { i, cell ->
  val src = Rect(cell.col * cellW, cell.row * cellH, (cell.col + 1) * cellW, (cell.row + 1) * cellH)
  val dst = Rect(x, y, x + w, y + h)
  canvas.drawBitmap(sprite, src, dst, paint)
  canvas.drawText((i + 1).toString(), x + 8f, y + 8f + textSize, badgePaint)
}
out.compress(JPEG, 82, baos)   // 3×3，每格 240×135 → 720×405
```

比 storyboard 手写 5×7 点阵字省事——Android 和浏览器都有字体。

#### 4.4 编号语义（多端必须一致）

```text
第 k 格（从 1 开始，左上→右下）覆盖 [t_k, t_k+1) 秒，t_k 来自 index[]
提示词只加一句：宫格共 9 格，编号对应时间，需要时按"第 k 格"引用
```

---

### 5. 网页端为什么绕不开 Worker

三个硬限制，浏览器直接拿雪碧图会失败：

1. **Referer 校验**：`i0.hdslb.com` 的图要求 Referer 是 bilibili.com，`fetch` 不能设 Referer；
2. **CORS**：拿字节做 canvas 处理需要 CORS 允许，B 站图床不保证；
3. **Canvas 污染**：跨域图片画进 canvas 后 `toBlob()` 抛 `SecurityError`。

所以网页端只能用 `/api/app/sprite` 代理字节——**但代理只转发，不做像素运算**。

App 不受这三条限制（自带 Cookie/Referer，本地文件），直连更快，代理只是兜底。

---

### 6. 上下文预算

`context-budget.ts` 增加 image 通道，manifest 记 `image:1/1 (384t)`：

```text
文字预算：10k 字符（现状）
图片预算：1 张宫格 = 384 token ≈ 1.2k 字符当量
规则：一次回复最多 1 张宫格
```

落库标记沿用现有占位符体系：`[宫格:sheets/日期/哈希.jpg#9格]`，`cleanUserText` 加一条正则。

---

### 7. 风险与取舍

| 风险 | 说明 | 应对 |
|---|---|---|
| 多端重复实现 | Kotlin + JS 各写一遍合成 | 合成只有 40 行；**选格算法**做成 Worker 只读端点（纯算术，微秒级），端上只执行 |
| 旧版本 App | 不认 `[宫格:]` | 未知占位符按现有逻辑降级 |
| 流量 | 每张 60–90KB 上传 | 仅 wifi 或用户主动点开时上传；hash 去重 |
| 客户端伪造 | 理论上可传任意图 | 自有设备，只做体积/类型校验 |
| 图片挤占上下文 | 多图导致掉智 | 硬上限 1 张 + 预算记账 |

---

### 8. 排期

```text
11/01 21:10 前  什么都不做（观察期冻结）
11/02           出 Phase 5 报告
11/03           Worker：3 个端点 + 预算/占位符 + 单测（约 1 天）
11/04–05        App：选格 + 合成 + 上传 + 聊天渲染（约 2 天）
11/06           真机回归：B 站卡片 → 宫格 → 模型引用"第 5 格"
11/07           Web：代理 + canvas 合成（1 天，可延后）
```

---

### 9. 验收

| 项 | 标准 |
|---|---|
| Worker CPU | `wrangler tail` 显示新增端点 CPU < 5ms |
| 图片体积 | 9 格 720×405 ≤ 120KB |
| 模型可用性 | 能回答"第 5 格大概是什么"且不跑偏 |
| 降级 | 关掉开关后行为与现在完全一致 |
| 可回滚 | 删占位符规则 + 端点，不动数据 |

---

### 10. 不做的事

- Worker 里不做像素合成、不做 jpeg 编码、不接 ffmpeg；
- 不搬它的切点检测 / ASR / 锐度选帧（B 站已给帧与时间点）；
- 不改现有 `[图片:]`/`[视频:]`/`[GIF:]` 协议，只新增 `[宫格:]`。

---

<!-- merged from: video-code-review.md -->

## 视频链路代码审查与优化清单

> 日期：2026-10-29  
> 范围：`ds-memory` Worker 的视频/GIF 相关代码；App 侧只列接口契约  
> 状态：只读审查，未改任何线上行为

---

### 0. 一句话

Worker 对视频的处理只有三行半：**收下来、存 R2、原样吐回去**。功能可用，但有 4 个真问题（其中 1 个是协议错误）和 5 个可以做的优化。

---

### 1. 现状盘点（代码位置）

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

### 2. 问题（按严重度）

#### 🔴 P0 · `/api/app/media` 声称支持 Range，实际不支持

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

#### 🟠 P1 · 视频占位符没被压缩，进了历史和记忆

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

#### 🟠 P1 · R2 里的视频永远不会被删

`cleanupStaleObjects` 只遍历 `context/`（`storage.ts:243`）。`videos/`、`gifs/`、`images/`、`audio/` 没有任何 TTL。

**量级**：单视频上限 60MB，R2 免费额度 10GB ≈ **170 个 60MB 视频就打满**；正常日常使用（每月几十条短视频）大概 3–6 个月触顶。

**修**：两选一或并用——
1. 每日归档任务里加 `listKeys('videos/')` + 按 key 里的日期判断，超过 N 天删除（视频正文已被 D1 记住，删的是原始文件）；
2. 或改用 R2 生命周期规则（对象前缀 + 过期天数），不占 Worker 运行时间。

**收益**：成本可控；避免"用到一半才发现写不进去"。

---

#### 🟡 P2 · 上传没有去重、没有流式、没有内容校验

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

#### 🟡 P2 · 缓存策略浪费流量

`index.ts:980`：`cache-control: private, max-age=86400`，没有 `ETag`/`If-None-Match`。

视频是一次写入、永不修改的对象，应该是 `immutable` + 长缓存；现在每过 24 小时就要重下 60MB。

**收益**（估）：同一条视频反复回放，第二次起流量降为 0；对手机端是实打实的流量和电量。

---

#### 🟡 P2 · 视频内容完全不进模型/记忆

现在模型对视频的全部认知就是 `[视频帧]` 这一个标记（`openai.ts:783`），或者由 App 临时上传的拼图（`#__transient`，不落库）。

**后果**：
- 同一个视频，重开对话就"忘了看过"；
- 记忆里没有任何视频语义，无法回答"上次那个视频讲什么来着"。

**修**：就是本文件第一部分（抽帧方案）的宫格方案 + `media_sheets` 表。

---

#### ⚪ P3 · B 站预览不返回帧信息

`link-preview` 返回 9 个字段，没有 `storyboard_url/cols/rows/index/cid/play_url`；而 App 的 `ApiClient.kt:844-849` 正在读这些字段——**死代码**。

**收益**：网页端第一次能显示视频帧；App 少一次自己调 `videoshot` 的往返。

---

### 3. 优化项汇总（含收益与成本）

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

### 4. 时间安排（受观察期约束）

```text
现在–11/01 21:10   只记录，不动代码（观察期冻结）
11/02             出 Phase 5 报告
11/03             #2 占位符压缩 + #1 Range（一起提交，半天）
11/04             #6 透传字段 + #5 缓存头（半天）
11/05             #3 TTL 清理（先 dry-run 列出将删的 key）
11/06+            #4 去重校验 → #7 宫格 → #8 元记忆
```

---

### 5. 我没做的验证

- 没测真实设备上的 Range 行为（推断依据是 HTTP 语义，不是实测）；
- 没查 R2 当前 `videos/` 的实际占用（需要 `list` 全量遍历，建议单独跑一次）；
- 没看 App 侧的上传实现细节（只看了接口调用点）。
---

### 6. 进度（2026-10-29 更新）

#### ✅ 已完成并提交

| # | 项 | 提交 | 状态 |
|---|---|---|---|
| 1 | `/api/app/media` 支持 Range/206/416 + ETag 304 + immutable | `c3ce525` | 代码+测试完成，**未部署** |
| 2 | `[视频]`/`[GIF]`/`[语音]` 占位符压成标记（历史 + 提炼共用） | `c3ce525` | 同上 |
| 2b | 提炼输入走同一份清洗（此前 `[图片:images/…]` 会进 memory.md） | `c3ce525` | 同上 |
| 9 | App：宫格按 `index[]` 裁剪真实帧 + 每格标时间 | `ds-mobile` 提交 | 已装真机，待真实视频复验 |

测试：`tsc` 0 错；vitest **62 文件 / 733 用例**全过（新增 `parseByteRange`、`sanitizeMessagePlaceholders` 两组）。

#### ⏸ 现在做不了的（记录在此）

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

#### 部署清单（11/02 后一条命令）

```bash
node node_modules/wrangler/bin/wrangler.js deploy --config wrangler.local.toml \
  --var MEMORY_ENGINE_QQ:shadow --var AFFECT_ENGINE_QQ:shadow \
  --var MEMORY_ENGINE_WEB:legacy --var AFFECT_ENGINE_WEB:legacy \
  --var MEMORY_ENGINE_MOBILE:shadow --var AFFECT_ENGINE_MOBILE:shadow \
  --var PROACTIVE_ENGINE:shadow --var PROACTIVE_DELIVERY:queue
```

部署内容仅：Range 支持 + 占位符清洗，不涉及引擎 flag、不改检索路径。
---

### 7. 2026-10-29 执行记录

#### 已上线

| 项 | 内容 | 证据 |
|---|---|---|
| Worker 部署 | Range/206/416 + ETag + immutable 缓存 + 占位符清洗 | 版本 `e7f6557e`，health 200，引擎 flag 未变 |
| 删除 secret | `BILIBILI_SESSDATA` 已删除（App 内有 933 字符完整 cookie，Worker 那份是冗余且失效的路径） | `wrangler secret list` 已无该项 |
| App | 只发一张宫格；Meta 说明编号/时间语义；无字幕时要求不编造台词 | `0408af4` |

#### 「模型把九宫格当普通图片」的根因与修复

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

#### 仍未做

- ~~R2 `videos/` TTL 清理~~ → **2026-10-29 实测不必要**，见下方占用快照
- 上传 hash 去重 + 魔数校验
- Worker 侧 `link-preview` 透传 storyboard 字段（网页端用；App 不依赖）
- `media_sheets` 元记忆（宫格目前 `#__transient`，不落库）
- **竖屏视频比例**：宫格固定 720×405，竖屏会被拉伸，需要按源比例算画布
#### R2 占用快照（2026-10-29，S3 API 只读统计）

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

---

<!-- merged from: bili-official-summary.md -->

## B 站官方摘要/字幕 取不到的原因

> 2026-10-29 排查，只读，未改线上

### 结论

**两个能力失败原因不同，不要混在一起看。**

| 能力 | 状态 | 根因 |
|---|---|---|
| 官方摘要 + 大纲 | **从来没成功过** | `conclusion/get` 必须登录态；当前请求是未登录身份 |
| 字幕 | 正常，按视频而异 | 今天这条视频本身没有字幕（B 站返回 `subtitles: []`） |

### 证据

#### 1. 无 Cookie 直连 `conclusion/get`

```text
nav        → code -101（账号未登录），但 wbi_img 仍可用
player/wbi/v2 → code 0，subtitles: []
conclusion/get → code -101 账号未登录，model_result 为空
```

返回的是 **-101（未登录）**，不是 **-352（签名错误）**，说明 WBI 签名是对的，卡在登录态。

#### 2. 历史消息对比（D1）

| 消息 | 视频 | 字幕 | 官方摘要 |
|---|---|---|---|
| id=1003（10/28） | 有 | **201 句** | ❌ 未获取到 |
| id=1111（10/29） | 今天这条 | 0 句 | ❌ 未获取到 |

字幕能拿到 201 句，说明**字幕后端链路是通的**（部分视频无需登录也能拿）；
但官方摘要在两个样本里**都是空的**，说明它一次都没成功过。

#### 3. 代码位置

`src/index.ts:862` —— 摘要和字幕都在同一个登录块内：

```ts
if (cookie.Cookie && cid) {   // cookie 来自 c.env.BILIBILI_SESSDATA
  const mixinKey = await biliMixinKey(headers);
  ...
  try { /* 字幕 */ } catch { /* 继续 */ }
  try { /* 官方摘要 */ } catch { /* 官方总结不可用时用简介兜底 */ }
}
```

两个 try/catch **都是空捕获**，失败时既不记录 code 也不记录 message，
所以线上看到的现象只有"没有摘要"，无法区分"cookie 过期"和"这个视频没有摘要"。

#### 4. Worker 里的 secret

`wrangler secret list` 确认 `BILIBILI_SESSDATA` 存在（值不可读）。

但仅凭 SESSDATA 往往不够：B 站 WBI 接口判断登录态还需要 `buvid3`。
只带 SESSDATA 时 `nav` 仍返回未登录，这正是当前症状。

### 建议修法（11/02 之后）

1. **补齐登录 cookie**：调 `x/frontend/finger/spi` 取 `buvid3/buvid4`，
   与 SESSDATA 一起放进 Cookie 头，再请求 `nav` 验证 `isLogin === true`。
2. **把失败写出来**：两个 catch 里记录 `code`/`message`，
   并在 `link-preview` 响应里加 `bili_login: true/false`，前端/Meta 里能看到"摘要不可用"是哪种原因。
3. **摘要降级链明确**：`conclusion` → 视频简介 → 无。
   现在其实就是这样，但因为没有诊断信息，看起来像 bug。
4. **字幕**：不需要改。没有字幕的视频（音乐/合集）本来就返回空，
   可以考虑在 Meta 里写"该视频没有字幕，不要编造台词"，避免模型自己脑补。

### 复现命令

```bash
node .bili-probe.mjs    # 无 cookie 探测 nav/player/conclusion 的 code
```

---
