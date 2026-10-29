# B 站官方摘要/字幕 取不到的原因

> 2026-10-29 排查，只读，未改线上

## 结论

**两个能力失败原因不同，不要混在一起看。**

| 能力 | 状态 | 根因 |
|---|---|---|
| 官方摘要 + 大纲 | **从来没成功过** | `conclusion/get` 必须登录态；当前请求是未登录身份 |
| 字幕 | 正常，按视频而异 | 今天这条视频本身没有字幕（B 站返回 `subtitles: []`） |

## 证据

### 1. 无 Cookie 直连 `conclusion/get`

```text
nav        → code -101（账号未登录），但 wbi_img 仍可用
player/wbi/v2 → code 0，subtitles: []
conclusion/get → code -101 账号未登录，model_result 为空
```

返回的是 **-101（未登录）**，不是 **-352（签名错误）**，说明 WBI 签名是对的，卡在登录态。

### 2. 历史消息对比（D1）

| 消息 | 视频 | 字幕 | 官方摘要 |
|---|---|---|---|
| id=1003（10/28） | 有 | **201 句** | ❌ 未获取到 |
| id=1111（10/29） | 今天这条 | 0 句 | ❌ 未获取到 |

字幕能拿到 201 句，说明**字幕后端链路是通的**（部分视频无需登录也能拿）；
但官方摘要在两个样本里**都是空的**，说明它一次都没成功过。

### 3. 代码位置

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

### 4. Worker 里的 secret

`wrangler secret list` 确认 `BILIBILI_SESSDATA` 存在（值不可读）。

但仅凭 SESSDATA 往往不够：B 站 WBI 接口判断登录态还需要 `buvid3`。
只带 SESSDATA 时 `nav` 仍返回未登录，这正是当前症状。

## 建议修法（11/02 之后）

1. **补齐登录 cookie**：调 `x/frontend/finger/spi` 取 `buvid3/buvid4`，
   与 SESSDATA 一起放进 Cookie 头，再请求 `nav` 验证 `isLogin === true`。
2. **把失败写出来**：两个 catch 里记录 `code`/`message`，
   并在 `link-preview` 响应里加 `bili_login: true/false`，前端/Meta 里能看到"摘要不可用"是哪种原因。
3. **摘要降级链明确**：`conclusion` → 视频简介 → 无。
   现在其实就是这样，但因为没有诊断信息，看起来像 bug。
4. **字幕**：不需要改。没有字幕的视频（音乐/合集）本来就返回空，
   可以考虑在 Meta 里写"该视频没有字幕，不要编造台词"，避免模型自己脑补。

## 复现命令

```bash
node .bili-probe.mjs    # 无 cookie 探测 nav/player/conclusion 的 code
```
