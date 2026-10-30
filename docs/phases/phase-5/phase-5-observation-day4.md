# Phase 5 Day 4 观察记录

日期：2026-10-29

用户反馈三个问题：

1. 断网后重复发送，恢复网络后一条消息卡在聊天底部；
2. AI 高频使用“（顿了顿）/（顿了一下）”；
3. 发送失败：HTTP 502，DeepSeek 返回 400。

## D4-01 pending 消息卡底

### 现象

断网时发送失败，用户又发了一次原消息；网络恢复后：

- 一条成功进入聊天记录；
- 另一条 pending 一直停在聊天底部；
- 之后发送新消息，旧 pending 仍然存在。

### 根因

- pending 只保存在本地 Room；
- 发送失败后，启动只做增量 `syncEvents`，不会按 `client_message_id` 对账；
- 旧 pending 没有服务端消息可匹配时，失败状态只存在内存 `failedPendingIds`，重启后也不会显示重试；
- 服务端已落库、但客户端没拿到响应时，pending 永久悬挂。

### 修复

- 新增 `GET /api/app/client-messages?ids=...`，按 `client_message_id` 查询服务端已落库消息；
- App 启动和发送失败后调用 `reconcilePending()`：
  - 服务端已有 → `applyServerMessages()` 删除 pending；
  - 服务端没有 → 标记失败，显示重试；
- 新增 `MessageDao.pending()` 一次性读取；
- 收到服务端消息时仍由 Room transaction 清理 pending。

### 验收

- 断网失败 → 恢复后重试成功，pending 消失；
- 服务端已落库但客户端报错 → 启动后 pending 自动消失；
- 真正未发送的 pending 显示“失败/重试”，不会伪装成发送中。

## D4-02 “顿了顿”口癖

### 现象

AI 很多句都带：

```text
（顿了顿，……）
（顿了一下，……）
```

### 判断

提示词里没有硬编码“顿了顿”，但有：

- “可以用（）写动作”；
- “只发一个动作”；
- “发动作或语音”；
- 历史回复里大量同款动作。

模型在模仿自己的历史口癖。

### 修复

- 不禁止动作、不限制表达自由；
- 把“可以用（）写动作”改为“表达方式由你决定，可以写也可以不写”；
- 增加一条自然变化提醒：

```text
不要为了显得像真人反复套用同一个停顿/动作词，
按情境判断，但保持自然变化。
```

- `STYLE_REMINDER` 同步加入这句，作为每轮最后提醒。

### 验收

不要求完全消失，只要求不再高频机械重复；不同场景使用不同表达。

## D4-03 HTTP 502 / DeepSeek 400

### 现象

App 显示：

```text
发送失败：HTTP 502:
{"message":"DeepSeek 返回错误（400）","type":"invalid_request_error"}
```

### 判断

- 502 是服务端包装；
- 内层是 DeepSeek 上游 **400 invalid_request_error**；
- 不是普通网络断开：网络断开通常表现为 fetch 失败/超时，不会拿到上游 400；
- 更可能是请求体/历史上下文触发的上游拒绝，或上游临时校验。

### 修复

- `deepseek.ts` 对 400 做一次**紧凑重试**：保留 system + 最近 14 条交互；
- 重试仍失败时，把上游 detail 截断 300 字记录到日志；
- 错误响应增加 detail 字段，便于后续定位；
- 不改模型/不改用户可见的普通错误语义。

### 验收

- 同样请求再次出现 400 时，紧凑重试优先成功；
- 仍失败时日志能看到上游 detail，而不是只有“400”。

## 验证

```text
Backend tests：720 passed
App debug Kotlin：编译通过
App release：已安装
Server deployed：b97e2b02（pending/400 修复）
```

## 状态

| 编号 | 状态 |
|---|---|
| D4-01 | 已修，待断网真机复验 |
| D4-02 | 已调整提示词，待观察口癖频率 |
| D4-03 | 已加重试与诊断，待复现确认根因 |

### 最终根因（补充）

用户复现后，App 显示了完整错误：

```text
Failed to parse the request body as JSON:
messages[0].content: unexpected end of hex escape
```

说明请求 JSON 里有**落单的 UTF-16 代理字符**（例如 emoji 被截断成 `\ud83d`），DeepSeek 直接 400。

处理：

- 在 `requestDeepSeek()` 边界统一调用 `sanitizeDeepSeekMessages()`；
- 清理 system/history/user 所有文本里的落单代理字符；
- 保留正常 emoji；
- 补 `deepseek-sanitize.test.ts`。

复测同一条消息：

```text
HTTP 200，正常返回
```

所以 502 不是网络波动，也不是 DeepSeek 配额，是请求 JSON 编码问题。
