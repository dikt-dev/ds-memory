# 后台保活与通知 · 现状盘点

> 盘点日期 2026-11-03。代码以 `ds-mobile` 为准，行号可能随提交漂移。
> 结论先放前面：**现在是两层机制**——前台服务（常驻、可选、默认关）+ 闹钟（不常驻、默认开）。
> 两者互不依赖，关掉前台服务照样有主动消息通知。

---

## 1. 两层机制

| | 层一：前台服务 `KeepAliveService` | 层二：闹钟 `ProactiveScheduler` |
| --- | --- | --- |
| 形态 | 常驻前台服务（通知栏一条通知） | `AlarmManager.setAndAllowWhileIdle` |
| 默认 | **关**（`SettingsStore.keepAliveEnabled` 默认 false） | **开**（`proactiveNotifyEnabled` 默认 true） |
| 唤醒频率 | 每 5 秒一次 `/api/app/events` | 每天 ≤4 次 + 每 30 分钟一次「补看」 |
| 延迟 | 5 秒内 | 计划时刻至多晚 45 分钟（超过就不弹） |
| 耗电 | 一条常驻通知 + 1.7 万次/天请求 | 40 次/天请求 |
| 依赖 | 用户手动开 + 系统不杀 | 只需闹钟权限 |
| 关机重启 | `START_STICKY` + `BootReceiver` | `BootReceiver` 重挂 |

---

## 2. 层一：KeepAliveService（`service/KeepAliveService.kt`，408 行）

### 2.1 启动路径

| 触发点 | 位置 | 条件 |
| --- | --- | --- |
| 聊天页打开 | `ChatActivity.kt:945` `LaunchedEffect(token, keepAliveEnabled)` | 有 token 且开关开 |
| 设置页开关 | `SettingsScreen.kt:367` | 即时生效（不等保存） |
| 调试页按钮 | `MainActivity.kt:211` | 手动 |
| 开机广播 | `BootReceiver.kt:26` | `start()` 内部再查一次开关 |

`start()` 第一件事就是查开关（`KeepAliveService.kt:90`），关着直接 return——所以外部随便调都安全。

### 2.2 运行时的两条循环

**① 增量消息轮询 `eventLoop()`（`KeepAliveService.kt:202`）**

```
首次启动：拉 latest=true 取一个基线 id，避免把历史消息全弹一遍
循环：GET /api/app/events?after=<lastEventId>&limit=100
     ├ 分页翻到底（hasMore 且 id 推进）
     ├ 新 assistant 消息 && App 不在前台 && 没通知过 → 弹通知
     ├ 去重集合上限 800，超了整体清空（宁可重复一次，不绝不漏）
     └ sleep 5s，顺手 markConnection() 刷新通知栏状态
```

**② 心跳 `heartbeatLoop()`（`KeepAliveService.kt:186`）**

每 5 分钟 `POST /api/app/heartbeat`。服务端 3 小时收不到才判「通道掉线」。

### 2.3 通知细节（这块踩过的坑最多）

- **每条消息用独立 notification id**（`MESSAGE_NOTIFICATION_ID + sourceId % 100000`，`:299`）——
  复用同一个 id 只会「更新通知」，系统不再弹悬浮横幅
- **声音/震动手动补一次**（`alertFallback()`，`:309`）——小米/HyperOS 会静默掉渠道的音效
- 渠道 `ds_messages_v2`（IMPORTANCE_HIGH + 锁屏可见 + 角标），旧渠道 `ds_messages` 主动删除，
  避免设置页出现重复项（渠道的重要级不能原地升级）
- 打开聊天页 → `clearMessageNotification()` 清通知 + 清零角标
- 文案：正文做 `replaceFaceMarkers` 去表情标记，压成单行，截 160 字

### 2.4 存活手段

| 手段 | 位置 | 说明 |
| --- | --- | --- |
| `START_STICKY` | `:145` | 被杀后系统重建 |
| `onTaskRemoved` 自杀式重拉 | `:148` | 划掉最近任务时 OEM 常顺手杀服务 |
| `stopWithTask="false"` | Manifest | 任务移除不连坐 |
| `foregroundServiceType="remoteMessaging"` | Manifest | Android 14+ 必须声明类型 |
| 电池优化白名单 | `MainActivity.kt:502` | 用户手动点「设为不限制」，跳系统授权页 |

### 2.5 停止时的心跳

`stop()`（`:106`）先 `stopService`，再补一次 `heartbeat("ds-mobile/background-off")`——
服务端据此区分「用户主动关」和「客户端死了」，不会 3 小时后误报掉线。

---

## 3. 层二：闹钟（`service/ProactiveScheduler.kt` 339 行 + `ProactiveCheckReceiver.kt` 157 行）

### 3.1 为什么不用精确闹钟

`setAndAllowWhileIdle` 不需要 `SCHEDULE_EXACT_ALARM` 授权，Doze 里也能醒；
代价是可能推迟十几分钟。主动消息本身带随机性，用户感知不到——所以用**提前量 + 截止线**吸收抖动：

| 常量 | 值 | 作用 |
| --- | --- | --- |
| `EARLY_MINUTES` | 3 | 比计划时刻早醒多少（留余量） |
| `MIN_LEAD_MS` | 60 s | 醒得太早（>1 分钟）就只把闹钟挪近，不发请求——省一次白醒 |
| `NOTIFY_DEADLINE_MINUTES` | 45 | 超过计划时刻这么久就不再弹，只等打开 App 看 |
| `MAX_SLOTS` | 4 | 一天最多 4 次档位唤醒 |
| `CATCHUP_INTERVAL_MS` | 30 min | 「补看」闹钟，不看计划 |

### 3.2 三类闹钟

| requestCode | 名称 | 行为 |
| --- | --- | --- |
| 100+ | 档位提醒 | 到点拉一次增量，有主动消息就弹通知 |
| 201 | 翻页（rollover） | 凌晨重算当天计划，顺带把自己推到明天 |
| 300 | 重挂（rearm） | 重新 `refresh()` |
| 400 | 补看（catchup） | 每 30 分钟醒一次，只拉增量；醒完立刻挂下一次 |

**补看闹钟是兜底**：档位闹钟依赖 `refresh()` 成功挂表，一旦计划拉取失败、App 当天没打开、
或服务端生成比档位晚几分钟，那次提醒就没了（线上真丢过）。补看不依赖任何计划。

### 3.3 失败重试

`ProactiveCheckReceiver`：没取到消息且未过截止线 → 最多重试 2 次（`MAX_RETRY`），
间隔由 `ProactiveScheduler.scheduleRetry` 控制（3 分钟一档，最多 4 档）。

---

## 4. 设置项与用户可见开关

| 开关 | 位置 | 默认 | 作用 |
| --- | --- | --- | --- |
| 后台常驻 | 设置 → 通知 | 关 | 启动前台服务（层一） |
| 到点提醒 | 设置 → 通知 | 开 | 挂闹钟（层二） |
| 电池优化白名单 | 调试页 | — | 跳系统授权页 |

---

## 5. 盘点中发现的问题

| # | 问题 | 位置 | 建议 |
| --- | --- | --- | --- |
| 1 | `notifyProactive()` 是死代码，无人调用 | `KeepAliveService.kt:265` | 删除，或真正接到队列推送（现在只有轮询） |
| 2 | 类注释还写着「阶段 0 的 spike / 每 3 秒查 health」 | `KeepAliveService.kt:34` | 已严重过期，改成「两层机制」说明 |
| 3 | `MIN_LEAD_MS` 注释说「提前 12 分钟挂」，常量是 3 分钟 | `ProactiveScheduler.kt:26` | 注释与实现不一致，订正 |
| 4 | 去重集合满了整体清空（`notifiedMessageIds.clear()`） | `:236` | 会重复弹最多 800 条区间内的消息；改成 LRU 或只清最旧 |
| 5 | 心跳与轮询各自 new `ApiClient` | `:191` `:228` | 每 5 秒构造一次 OkHttp 客户端持有者，可复用 |
| 6 | 无「服务被杀」的可见反馈 | — | 通知栏状态会停在最后一次成功；可加心跳失败计数显示 |

---

## 6. 与主动消息链路的配合

```
服务端 cron 生成主动消息 → events 表
        │
        ├─ 层一开着：5 秒内推送通知（实时感）
        └─ 层一关着：等档位/补看闹钟醒来拉（≤30 分钟延迟）
```

**关掉前台服务不等于没有通知**——只是延迟从 5 秒变成最多 30 分钟。这点在设置页文案里应该写清楚。
