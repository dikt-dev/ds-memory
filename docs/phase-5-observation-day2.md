# Phase 5 观察 · Day 2

> 起始：2026-10-26 Day 1 封板后继续（Asia/Shanghai）
> 观察窗口：2026-10-25 21:10 — 2026-11-01 21:10

## Day 1 封板状态

已完成：

- 重复用户消息去重（`client_message_id` + Room transaction）
- 移除“大肥鱼 · 正在输入”
- B 站链接尾部中文拆出卡片
- 称呼优先级修正（喜欢“大人”，不喜欢“大肥鱼”）
- 主动消息改为分钟级随机触发
- 图片/视频/文件本地草稿、预览、先落本地再上传
- 首屏最近媒体预解码（最多 6 个）
- `/更正` 记忆纠正命令
- 归档旧消息回灌：`/api/app/events` 自动接 R2 `chat_logs`
- 当前周/月 rollup 在纠正后重新生成
- 已完成项目归档去掉“完成了：”前缀，直接保留原事项

Day 1 发现但未完全关闭：

1. 键盘首次弹出时的页面动画仍需要真机确认；如果仍卡，下一步做 IME inset 预热/固定高度，而不是继续加媒体缓存。
2. 失败附件还没有“重新上传”状态机；目前失败附件隐藏重试按钮，避免空文本重发。
3. 直接手改 `memory.md`（不走 `/更正`）时，当前周/月 rollup 不会自动失效。
4. `archiveCompletedItems` 仍会把已完成项目移到共同经历，但现在只保留原事项，不再加“完成了：…”。

## Day 2 观察配置

保持：

```text
MEMORY_ENGINE_MOBILE=shadow
AFFECT_ENGINE_MOBILE=shadow
MEMORY_ENGINE_WEB=legacy
AFFECT_ENGINE_WEB=legacy
PROACTIVE_ENGINE=shadow
PROACTIVE_DELIVERY=queue
```

## Day 2 重点

- 验证重复消息是否彻底消失；
- 验证附件是否先出现本地气泡和缩略图，再出现 AI 回复；
- 验证 B 站链接后文字是否留在卡片外；
- 验证键盘首次弹出是否仍有页面卡顿；
- 观察 `/更正` 后新事实是否立即生效；
- 继续观察 memory / affect / proactive 的 mobile shadow 指标。

## 当日快照

按天运行：

```bash
cd ds-memory
node scripts/p5-observe.mjs
```

快照写入 `backup/p5-observation/YYYY-MM-DD.json`（gitignored）。
