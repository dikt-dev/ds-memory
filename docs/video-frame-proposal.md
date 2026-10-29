# 视频宫格（storyboard）能力方案

> 状态：**提案，待评审**，不动线上  
> 对象：B 站视频卡片 + 动图/GIF 的"画面通道"  
> 参考：[dsh-video-storyboard](https://github.com/SAOS-3624/dsh-video-storyboard)（MIT，v0.4.3）  
> 排期建议：2026-11-02 出完 Phase 5 报告之后

---

## 1. 先看现状：我们其实已经有一半

| 能力 | ds-memory（现在） | dsh-video-storyboard | 差距 |
|---|---|---|---|
| B 站元数据 | ✅ `/api/app/link-preview` | — | 无 |
| B 站字幕 | ✅ `player/wbi/v2` | — | 无 |
| 官方摘要/大纲 | ✅ `conclusion/get` | — | 无 |
| **视频画面** | ❌ Worker 完全没看过 | ✅ 切点+取帧+选锐 | **核心缺口** |
| 帧的**时间戳索引** | ❌ 只有客户端本地 | ✅ `index[]` | 缺口 |
| 宫格排版数学 | ❌ | ✅ `plan.js` 纯函数 | 可移植 |
| RGBA 合成/烧编号 | ❌（只有压缩） | ✅ `sheet.js` | 可移植 |
| 图片 token 预算 | ❌ 只算字符 | ✅ `PIXEL_BUDGET`/`384` | 可借鉴 |
| 缓存/失效 | ✅ KV + source_hash | ✅ path+mtime | 我们更强 |
| 元记忆"看过" | ❌ | ✅ `memory.js` | 小缺口 |

**关键发现（决定了整个方案走向）**：

1. B 站官方就有 ready-made 的 sprite sheet：`x/player/videoshot` 返回 `image[]`（多张雪碧图）、`index[]`（每帧对应秒数）、`img_x_len/img_y_len`。App 已经在用（`ds-mobile/app/BiliFrames.kt`、`net/ApiClient.kt:571-580`）。
2. **我们的 Worker 没有把这个能力暴露出来**：`link-preview` 返回体里没有 `storyboard_url`，所以 `ApiClient.kt:847-848` 那条读取分支是死代码，网页端更是完全拿不到帧。
3. 我们有 `jpeg-js` + `upng-js` + 自己写的 `downscaleRGBA`（`src/media.ts`），**已经能在 Worker 里解码/缩放/编码图片**，只差"裁切 + 画字 + 拼版"。

结论：**不需要搬它的 ffmpeg 管线，也不需要切点检测**——B 站把切点（`index[]`）和帧（雪碧图）都给我们了。真正要借的只有两样：布局数学、RGBA 合成。

---

## 2. 三条路线与取舍

### 路线 A：整条管线搬进 Worker
把 `scan.js`/`pipeline.js`/`asr.js` 都搬来。
**否决**：依赖 ffmpeg + `child_process` + 本地磁盘，Worker 根本没有；而且我们也不需要自己找切点。

### 路线 B：决策在服务端、执行分两端（推荐）
- **服务端**：拿 `videoshot` 的雪碧图 + `index[]` → 决定"选哪 9 格、几行几列、每格多大" → 裁切缩放 → 烧编号 → JPEG → R2。
- **客户端**：只在服务端不可用时兜底（现有 `BiliFrames.kt` 逻辑保留）。
- **收益**：网页端第一次能"看"视频；App 不再各自实现一套排版；编号可引用、可落库、可回放。

### 路线 C：全交给客户端
**否决**：网页端永远没有画面；编号规则各端不一致；无法把"看过这段视频"写进长期记忆。

---

## 3. 方案 B 的分阶段实施

每阶段独立可回滚、有单测、不改变现有行为（除非显式打开开关）。

### P1 · 纯函数：排版数学（零风险，先做）

新增 `src/frame-plan.ts`，从 `plan.js` 移植（MIT，保留版权声明）：

```text
bestLayout(n, aspect)   → { cols, rows, capacity, canvasAspect }
snapCells(n)            → 4 | 6 | 9 | 12 | 16
cellSize(cols, rows, aspect, budget) → { w, h }
planFrames({ duration, index[], subtitle, budget })
```

**改造点（比原版更适合我们）**：

| 原版做法 | 我们的做法 | 理由 |
|---|---|---|
| `suggest()` 按 `motion` p90 决定格数 | 按**字幕密度**决定（有台词时 6–9 格，纯画面 12–16） | 我们拿不到 motion，但**有完整字幕**（`subtitle_count`） |
| 均匀取格 | 按字幕段密度加权，快说段多给格（`density.js` 的"积分等分"思路） | 口播视频里"话密"= 信息密 |
| 格数上限 16 | 上限 9（3×3），必要时 12 | 图片 token 是 384/张，10 分种视频 16 格收益递减 |

**验收**：纯单测，覆盖 n=4/6/9/12/16、异常输入、比例极端值。跑通即提交，不接线上。

### P2 · 合成：雪碧图 → 编号宫格（本地脚本先验证）

新增 `src/frame-sheet.ts`：

```text
cropCell(sprite, cols, rows, i)  → RGBA          // 从雪碧图裁一格
scaleRGBA(...)                    → RGBA          // 复用 media.ts 的降采样
drawBadge(rgba, w, h, x, y, n)   → void          // 5×7 点阵数字，无字体依赖
composeSheet(cells, layout)      → { rgba, w, h }
encodeJpeg(rgba, w, h, q)        → Uint8Array    // jpeg-js
```

先做成 `scripts/frame-demo.mjs`（Node 本地跑，用真实 B 站视频），**不是 Worker 代码**。目的是拿到三个数：

1. 一张 9 格宫格的真实体积与尺寸；
2. 单次合成的耗时（Node 数字 × 3 ≈ Worker 的粗略上界）；
3. 压缩质量阈值（0.65 / 0.7 / 0.75 三档对比）。

**这一步的产出一张图，发给你看效果，再决定要不要进 Worker。**

### P3 · 接口：让 Worker 提供帧

在 `/api/app/link-preview` 响应里补字段（纯透传，先不加合成）：

```json
{
  "storyboard_url": "https://i0.hdslb.com/bfs/storyboard/...",
  "storyboard_cols": 10,
  "storyboard_rows": 10,
  "storyboard_index": [0, 1.2, 2.4, ...],
  "storyboard_size": { "x": 160, "y": 90 }
}
```

这一步**网页端立刻受益**（不用改前端也能在卡片上显示雪碧图），且完全可回滚（多几个字段而已）。

### P4 · 服务端合成（受 CPU 预算约束，默认关）

新增 `POST /api/app/sheet`（`requireApp`）：

- 入参：`bvid` 或 `sprite_url` + 选格参数；
- 服务端拉雪碧图 → 合成 → 存 R2 `sheets/{date}/{hash}.jpg`；
- 返回：`{ key, cols, rows, cells: [{ n, t, w, h }], tokens } `；
- 缓存键 = `sha256(sprite_url + 选格参数)`，命中直接返回（对应它的 `cache.js`，但我们用内容 hash 而不是 mtime）。

**硬约束**：必须用 `wrangler tail` 实测 CPU time。免费版 10ms、付费 50ms，**9 格合成很可能超**。所以：

```text
默认：不启用服务端合成，link-preview 只返回 sprite 信息（P3）
条件启用：白名单 / 管理端手动触发 / 首次出现的视频卡片且 duration < 10min
降级：合成失败 → 返回 null → 客户端沿用现有本地抽帧
```

### P5 · 预算与协议（和记忆系统对齐）

1. `context-budget.ts` 增加 **image 通道**：`{ images: number, imageBudget: 384 * n }`，manifest 里记 `image:1/1 (384t)`。这直接借用它的 `IMAGE_TOKEN_CAP`。
2. 落库用可读标记：`[宫格:sheets/2026-11-02/abc.jpg#9格@每格30s]`，与现有 `[图片:]`/`[视频:]` 同一套解析（`cleanUserText` 已能处理占位符，只需加一条规则）。
3. prompt 侧只加一句：这个宫格共 N 格、第 k 格约在第 `(k-1)*Δt` 秒，需要时按"第 k 格"引用。**不要**再写长篇解释（我们现在 `withMontageHint` 已经证明"说多了模型反而跑偏"）。

### P6 · 元记忆（可选，最后做）

新增 D1 表 `media_sheets(id, source_url, sprite_hash, cells, created_at, uses)`，等价于它的 `memory.js`，但落 D1 而不是本地 jsonl——这样跨设备、跨会话都能说"这段视频我看过"。

---

## 4. 为什么要改造它的设计，而不是照搬

| 它的做法 | 问题 | 我们的做法 |
|---|---|---|
| 自己找切点（HSV 差分 + 速率阈值） | Worker 里做不到，也没必要 | 用 B 站 `index[]` |
| ffmpeg 取帧 + Laplacian 选锐 | 同上 | 雪碧图本身就是均匀采样，质量由 B 站决定 |
| 缓存键 = path + size + mtime | 我们多端多租户，路径不稳定 | `sha256(sprite_url + 参数)` |
| 元记忆写本地 jsonl，400 行截断 | 换设备就丢 | D1 表 + TTL |
| 格数由 motion p90 决定 | 我们没有 motion | 由字幕密度 + 时长决定 |
| 384 token 写死 | 可能和实际计费不符 | 先按 384 估，再用 `usage` 校准 |

---

## 5. 风险

| 风险 | 影响 | 应对 |
|---|---|---|
| Worker CPU 超限 | 合成请求 500 | P2 先测；默认关；失败降级到客户端 |
| 内存（128MB） | RGBA 大图撑爆 | 单图上限 720×405；逐格合成不整张解码（雪碧图必须整张解码，注意 100 格雪碧图本身可能很大） |
| R2 成本 | 每个视频一张图 | 内容 hash 去重 + 30 天 TTL + 小号桶 |
| 版权/隐私 | 缓存第三方帧 | 只私有存储、不外链、定期清理 |
| 图片挤占上下文 | 803 页图片过多导致降智 | image 预算独立，且一次最多 1 张宫格 |

---

## 6. 验收

| 阶段 | 验收 | 回滚 |
|---|---|---|
| P1 | 单测全绿；`tsc --noEmit` 0 错 | 删文件 |
| P2 | 本地出图，人工看效果；记录耗时/体积 | 删脚本 |
| P3 | App/Web 能显示雪碧图；接口字段向后兼容 | 去掉字段 |
| P4 | `wrangler tail` CPU 实测 < 40ms；失败率 0 | 开关关闭 |
| P5 | 预算 manifest 出现 image 项；一张宫格 384 token 内 | 恢复纯文字预算 |
| P6 | 重复问同一视频不再重复生成 | 停用表 |

---

## 7. 排期

```text
11/02  出 Phase 5 报告（不动代码）
11/03  P1 排版纯函数 + 单测（半天）
11/04  P2 本地脚本出图，给你看（半天）
11/05  决定是否进 Worker；P3 透传字段（半天）
11/06+ P4 合成接口（需先过 CPU 实测）→ P5 预算/协议
```

---

## 8. 不做的事

- 不搬 ffmpeg / ASR / 切点检测（Worker 跑不了，且 B 站已给）；
- 不在 Worker 做视频解码；
- 不改现有 `[图片:]` / `[视频:]` / `[GIF:]` 协议，只新增 `[宫格:]`；
- 不在 Phase 5 观察期内动任何线上行为。
