# 生产运维笔记（2026-10-24）

## 主动消息：23:00 未下发的根因

固定时段：

```text
morning: 07:45–08:15
evening: 22:45–23:15
```

目标是按日期确定的分钟级随机时间。2026-10-24 的 evening 目标是 **23:12**。

cron 每 5 分钟触发：

```text
23:00  ← 未到 23:12
23:05  ← 未到
23:10  ← 未到
23:15  ← 旧代码 currentSlot 用 [start, end)，判定为窗口外
```

因此整段 evening 被跳过，`proactive_log` 里没有 evening 记录。

### 修复

`currentSlot` 的 end 也包含在窗口内，让 23:15 这个 tick 能补发 23:12 的目标。
morning 的 08:15 同理。

回归测试覆盖：目标时间落在两个 5 分钟 tick 之间时，后一个 tick 仍在窗口内。

### 观察

- 2026-10-24 的 23:00 消息已错过，不会自动补发；
- 需要补发时可调用：

```text
POST /api/admin/proactive-send-now
Authorization: Bearer <ASTROBOT_API_KEY>
{"kind":"evening"}
```

- 队列模式下 `proactive_log=queued` 只代表入队；客户端 ack 后会改为 `sent`。
  旧数据已用 SQL 回填。

## 小号 R2 兜底

生产诊断接口：

```text
GET /api/admin/storage-check
Cookie: ds_token=...
```

2026-10-24 实测：

```json
{
  "mode": "main",
  "secondary_enabled": true,
  "probe": {
    "configured": true,
    "put": 200,
    "get": 200,
    "delete": 204,
    "body": "ok",
    "fallback": "ok"
  }
}
```

- `put/get/delete` 直接在 S3 API 上验证小号；
- `fallback` 验证主模式下 `getObject` 能回源到小号；
- 写侧已补：secondary 模式 PUT 失败时回退主账号，避免小号故障导致记忆写失败。

## 大 GIF 上传

生产接口：

```text
POST /api/upload/image
Authorization: Bearer <ASTROBOT_API_KEY>
Content-Type: image/gif
（raw binary）
```

- 原图原样写 R2，不压缩；
- 客户端先直传，再用 `image_keys` 记录 key；
- 抽帧后用帧拼图给模型，不再把 6MB 原图 base64 塞进 8MB chat JSON。
