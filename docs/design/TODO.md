# 待办

## 1. 搬家按钮（App / 网页）

- 现在只有接口：`POST /api/admin/life/move?city=<城市>`（管理员 cookie）
- 要做：设置页里一个「搬家」入口，选城市 → 确认 → 调用接口
- 语义：**永久**改 `life:home-city`，重生成当天日程，写一条记忆；旅游是临时的，会自动回来

## 2. 天气必须两边分别取

- 她那边：`life:env:{date}`，城市来自 `life:home-city`（或当天旅游目的地）
- 你那边：`life:user-env:{date}`，城市来自 `life:user-city`（App 定位写入）
- **任何新增的取天气的地方都要成对取**，不许复用同一条记录——她和你不在一个城市是常态
- 现状：`refreshLifeEnv()` 会同时刷新两份；App 定位变更时会立刻刷`user-env`
