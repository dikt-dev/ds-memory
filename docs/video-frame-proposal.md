# 视频宫格（storyboard）能力方案 v2 · 客户端优先

> 状态：**提案，待评审**，不动线上  
> 变更：v1 把合成放在 Worker，需要赌 CPU 预算；v2 把重活全部挪到端上，Worker 只做存储/协议/代理  
> 参考：[dsh-video-storyboard](https://github.com/SAOS-3624/dsh-video-storyboard)（MIT，v0.4.3）

---

## 1. 结论

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

## 2. 分工

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

## 3. 接口（Worker 只加三个轻端点）

### 3.1 `GET /api/app/sprite?bvid=...` — 代理雪碧图字节

给网页端用（原因见 §5）。App 可不用（它自己带 Cookie 直连更快）。

```text
→ 流式返回 image/jpeg（或 302 到 i0.hdslb.com）
→ 响应头 X-Storyboard-Cols / X-Storyboard-Rows / X-Storyboard-Index(JSON)
```

CPU：纯转发，不做像素运算。可加 1 天 R2 缓存。

### 3.2 `POST /api/app/sheet` — 接收端上合成好的图

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

### 3.3 `link-preview` 补字段（透传，向后兼容）

```json
{ "storyboard_url": "...", "storyboard_cols": 10, "storyboard_rows": 10,
  "storyboard_index": [0, 1.2, ...], "cid": 123, "play_url": "..." }
```

App 的 `ApiClient.kt:844-849` 早就在读这几个字段，现在是死代码。

---

## 4. 端上算法（这才是"怎么做更好"的核心）

### 4.1 选格：按字幕密度，不按均匀间隔

`index[]` 给了每帧的秒数，字幕给了每句时间。做法：

```text
1. 时间轴切成 N×3 个候选窗口
2. 每窗口权重 = 台词字数 / 窗口时长（信息密度）
3. "积分等分"选出 N 格：让每格承载的台词量大致相等
4. 约束：格间最小间隔 ≥ 总时长 × 0.15；首尾各留 5%
```

方法借自 storyboard 的 `density.js`（它按剪辑率积分，我们按台词密度积分），不是抄代码。

### 4.2 格数

| 时长 | 有字幕 | 无字幕 |
|---|---|---|
| < 90s | 4 格（2×2） | 6 格 |
| 90s–10min | 6 或 9 格 | 9 格 |
| > 10min | 9 格 + 注明"只覆盖前 10 分钟" | 12 格 |

上限 9 格：一张图 384 token，12 格以上边际收益递减，手机上拼图也会糊。

### 4.3 合成（约 40 行）

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

### 4.4 编号语义（多端必须一致）

```text
第 k 格（从 1 开始，左上→右下）覆盖 [t_k, t_k+1) 秒，t_k 来自 index[]
提示词只加一句：宫格共 9 格，编号对应时间，需要时按"第 k 格"引用
```

---

## 5. 网页端为什么绕不开 Worker

三个硬限制，浏览器直接拿雪碧图会失败：

1. **Referer 校验**：`i0.hdslb.com` 的图要求 Referer 是 bilibili.com，`fetch` 不能设 Referer；
2. **CORS**：拿字节做 canvas 处理需要 CORS 允许，B 站图床不保证；
3. **Canvas 污染**：跨域图片画进 canvas 后 `toBlob()` 抛 `SecurityError`。

所以网页端只能用 `/api/app/sprite` 代理字节——**但代理只转发，不做像素运算**。

App 不受这三条限制（自带 Cookie/Referer，本地文件），直连更快，代理只是兜底。

---

## 6. 上下文预算

`context-budget.ts` 增加 image 通道，manifest 记 `image:1/1 (384t)`：

```text
文字预算：10k 字符（现状）
图片预算：1 张宫格 = 384 token ≈ 1.2k 字符当量
规则：一次回复最多 1 张宫格
```

落库标记沿用现有占位符体系：`[宫格:sheets/日期/哈希.jpg#9格]`，`cleanUserText` 加一条正则。

---

## 7. 风险与取舍

| 风险 | 说明 | 应对 |
|---|---|---|
| 多端重复实现 | Kotlin + JS 各写一遍合成 | 合成只有 40 行；**选格算法**做成 Worker 只读端点（纯算术，微秒级），端上只执行 |
| 旧版本 App | 不认 `[宫格:]` | 未知占位符按现有逻辑降级 |
| 流量 | 每张 60–90KB 上传 | 仅 wifi 或用户主动点开时上传；hash 去重 |
| 客户端伪造 | 理论上可传任意图 | 自有设备，只做体积/类型校验 |
| 图片挤占上下文 | 多图导致掉智 | 硬上限 1 张 + 预算记账 |

---

## 8. 排期

```text
11/01 21:10 前  什么都不做（观察期冻结）
11/02           出 Phase 5 报告
11/03           Worker：3 个端点 + 预算/占位符 + 单测（约 1 天）
11/04–05        App：选格 + 合成 + 上传 + 聊天渲染（约 2 天）
11/06           真机回归：B 站卡片 → 宫格 → 模型引用"第 5 格"
11/07           Web：代理 + canvas 合成（1 天，可延后）
```

---

## 9. 验收

| 项 | 标准 |
|---|---|
| Worker CPU | `wrangler tail` 显示新增端点 CPU < 5ms |
| 图片体积 | 9 格 720×405 ≤ 120KB |
| 模型可用性 | 能回答"第 5 格大概是什么"且不跑偏 |
| 降级 | 关掉开关后行为与现在完全一致 |
| 可回滚 | 删占位符规则 + 端点，不动数据 |

---

## 10. 不做的事

- Worker 里不做像素合成、不做 jpeg 编码、不接 ffmpeg；
- 不搬它的切点检测 / ASR / 锐度选帧（B 站已给帧与时间点）；
- 不改现有 `[图片:]`/`[视频:]`/`[GIF:]` 协议，只新增 `[宫格:]`。
