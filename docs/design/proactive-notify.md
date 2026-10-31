# 主动消息「到点提醒」（闹钟唤醒）

> 2026-10-31 落地。取代"前台服务每 5 秒轮询"，请求量从 17,280 次/天降到 4~8 次/天。

## 一句话

服务端 cron 照旧决策和生成（链路不动），只多一个只读接口告诉 App「今天几点她大概会来」；
App 用**不需要权限**的 `setAndAllowWhileIdle` 在目标前 12 分钟醒来，拉一次 `/api/app/events`，
有新的主动消息就弹本地通知。

## 为什么不需要精确闹钟

主动消息的内容和"哪一分钟发出"没有关系：早间窗口 07:45–08:15、深夜 22:45–23:15 本身就是 30 分钟宽。
所以闹钟设在窗口内任意一点都算对，系统把它推迟 10~20 分钟也还在窗口内。

- `SCHEDULE_EXACT_ALARM` 在 Android 14+ 默认不授予普通应用，要用户去系统设置手动开——直接不用它。
- `setAndAllowWhileIdle` 无需权限、Doze 里也能醒，代价是"不精确"（系统给的 window 是 +1h）。
- 提前量 `EARLY_MINUTES = 12` 就是为这个抖动留的余量。

## 链路

1. **每天 04:00 归档时**（可选）没有新增写表任务：时间本来就是日期种子的纯函数
   （`targetMinutesFor` / `randomTargetMinutes`），"发过没"在 `proactive_log` 里。
2. App 打开 / 开机 / 切开关时调 `GET /api/proactive/plan`，拿到今天 4 个候选档。
3. `ProactiveScheduler` 在每个 `at - 12min` 挂一个闹钟（`RTC_WAKEUP`），最多 4 个。
4. 闹钟醒来 → `ProactiveCheckReceiver`：`heartbeat("ds-mobile/alarm")` + `events?after_id=`。
5. 有新的主动消息（`proactive_kind != null`）→ `ProactiveNotifier` 弹通知，更新 `last_notified_id`。
6. 没有 → 若 `now < target + 30min`，10 分钟后重试（最多 2 次）；否则静默放弃。
7. 计划接口挂了 → App 用兜底时段（07:50 / 22:50）。

## 失败与边界

| 情形 | 行为 |
|---|---|
| 系统把闹钟拖后 20 分钟 | 仍落在窗口内，通知只是晚一点 |
| 拖到超过 target + 30min | 不弹通知，只等下次打开 App 看（避免"睡前那句"在 00:20 响） |
| 手机没电 / 关机 | 服务端 cron 照常生成并落库，开机后 `BootReceiver` 重挂；打开 App 就能看到 |
| 用户强行停止 App | 所有闹钟失效，直到手动再打开（Android 的设计，无解） |
| HyperOS 限制后台 | 必须把 App 电池策略设成"无限制"，否则闹钟可能被拖几小时 |

## 观测

- 诊断页「最近唤醒」：计划时刻 vs 实际醒来 vs 延迟分钟 vs 有没有取到（存 `SettingsStore.proactiveWakeLog`）。
- 服务端 `/api/proactive/stats` 的 `heartbeat.version` 应为 `ds-mobile/alarm`。
- `dumpsys alarm | grep PROACTIVE_CHECK` 可看到挂着的闹钟（`origWhen` 应等于目标时刻 - 12 分钟）。

## 与后台保活的关系（2026-10-31 已完结）

保活（KeepAliveService）从主路径退场：默认关，仍保留给"想要实时"的人开。

同一批做掉的退役：

| 退役项 | 原因 |
| --- | --- |
| PROACTIVE_DELIVERY 队列模式 | 队列要一个常驻消费者，没人取就积压；proactive_log 永远 queued，看着像发送失败 |
| deliverProactive 的 AstrBot 直连分支 | QQ 方案整体废弃 |
| /api/proactive/pending、/nack、/ack、/drop | 队列接口，没有消费者了 |
| src/queue.ts + 队列清理任务 | 同上 |
| checkChannelOffline（QQ 通道掉线提醒） | 只为 QQ 通道可见性存在 |

现在的投递只有一个动作：deliverProactive 直接返回 { mode: 'events', status: 'sent' }——
消息已经落在 messages 里，App 醒来按 after_id 拉增量。
/api/proactive/stats 仍留心跳与暂停状态，供诊断页看。
