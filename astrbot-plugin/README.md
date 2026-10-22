# 小忆主动消息推送插件（AstrBot）

把「小忆」（Cloudflare Worker 版 AI 记忆助手）**主动想说的话**推送到 QQ 等平台。

## 为什么需要它

你的小忆跑在 Cloudflare Workers 上，而 AstrBot 跑在你自己的机器上：

- Workers **不能**维持 WebSocket 长连接
- Workers **不能**直接访问你局域网里的 AstrBot

所以反过来做 —— **AstrBot 主动往外轮询**：

```
Cloudflare Worker                    你的 AstrBot
  生成主动消息                         定时轮询（每 60 秒）
       ↓                                    ↓
  proactive_queue 表  ←──── GET /api/proactive/pending ────┘
       ↑                                    ↓
       └──── POST /api/proactive/ack ── 推送到 QQ
```

## 安装

1. 把整个 `astrbot-plugin` 文件夹复制到 AstrBot 的插件目录，**重命名为** `astrbot_plugin_memory_push`：

   ```
   AstrBot/data/plugins/astrbot_plugin_memory_push/
   ├── main.py
   ├── metadata.yaml
   ├── _conf_schema.json
   └── README.md
   ```

2. 重启 AstrBot，或在 WebUI「插件管理」里点「重载插件」。

3. 确保 `aiohttp` 可用（AstrBot 自带，通常无需安装）。

## 配置

在 AstrBot WebUI →「插件管理」→「小忆主动消息推送」→「配置」里填写：

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| **`ds_base_url`** | 你的 Worker 地址，不要带结尾 `/` | `https://your-worker.example.com` |
| **`api_key`** | 即 Worker 里的 `ASTROBOT_API_KEY` | （留空，必须填） |
| **`target_umo`** | 目标会话 UMO | 留空自动学习 |
| `poll_interval` | 轮询间隔（秒） | `60` |
| `enable_auto_learn` | 自动记住第一个说话的会话 | `true` |
| `quiet_hours` | 免打扰时段（24 制小时列表） | `[1,2,3,4,5,6]` |
| `max_per_poll` | 单次最多拉几条 | `5` |

### 关于 target_umo

`unified_msg_origin`（UMO）是 AstrBot 用来定位「哪个平台的哪个会话」的字符串，格式大致是：

```
aiocqhttp:FriendMessage:123456789
```

**最简单的方式**：保持 `target_umo` 留空，`enable_auto_learn` 开启，然后**私聊机器人随便发一句话**——插件会自动把那个会话记为目标，之后主动消息就发到那里。

也可以手动用指令设置：

```
/肥鱼记住这里
```

## 指令

| 指令 | 作用 |
|------|------|
| `/肥鱼状态` | 查看服务地址、目标会话、轮询间隔、当前待发条数 |
| `/肥鱼立即推送` | 立即拉取并推送一次（调试用） |
| `/肥鱼记住这里` | 把当前会话设为目标推送会话 |

## 工作原理

1. Worker 的三个 cron 触发 `runWebProactiveSlot` / `runWebProactiveRandom`
2. 决策通过后，生成消息并**写入队列**（不会自己发，因为 Worker 发不到 QQ）
3. 插件每 `poll_interval` 秒 `GET /api/proactive/pending`
4. 拉到消息后用 `context.send_message(umo, chain)` 推送
5. 推送成功 → `POST /api/proactive/ack` 标记已发
6. 推送失败 → 不 ack，下次重试；累计 5 次后 Worker 放弃（避免坏消息卡死队列）

## 免打扰

默认 `[1,2,3,4,5,6]` 表示**凌晨 1 点到 6 点不推送**——即使队列里有消息也先存着，等你醒来再发。

想全时段推送就把 `quiet_hours` 设为空列表 `[]`。

## 排查

| 现象 | 检查 |
|------|------|
| 日志出现「未配置 ds_base_url 或 api_key」 | 配置没保存，回 WebUI 检查 |
| 日志出现「api_key 不对（401）」 | `api_key` 与 Worker 的 `ASTROBOT_API_KEY` 不一致 |
| 一直「还没学到会话」 | 私聊机器人发条消息，或用 `/肥鱼记住这里` |
| 队列一直空 | Worker 端主动消息决策未通过，属正常（需要足够的关系/情绪信号） |
| 推送失败 | 检查 AstrBot 的 QQ 适配器是否正常，能否正常主动发消息 |

## Worker 端需要确认的配置

```toml
# wrangler.toml
ASTROBOT_API_KEY = "..."          # 必须，且与插件 api_key 一致
ASTROBOT_PUSH_ENABLED = "true"    # 开启后 cron 才会写队列
```

如果 `ASTROBOT_PUSH_ENABLED` 没开，队列永远是空的。

## 许可

MIT
