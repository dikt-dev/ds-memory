# 活动单元池 · 首批草稿（64 条 + 7 配方）

> 配套 ai-life-system.md 5.2。字段口径见 5.2.1。
> 用法：直接在表里删改；增删一条不影响代码，只是池子大小变化。
> 社交单元的朋友是固定班底，见 ai-life-system.md 5.7。

每条格式：**id** 名称 ｜ 时长(分钟) ｜ 标签 ｜ 心情 ｜ 回复率 ｜ 填充提示
标签取值：indoor / outdoor / rainy_ok / sunny_only / hot_ok / cold_ok / alone / tired_ok / noisy

## 一、看番看剧（arc = series）

> 推进量由代码决定、不由模型决定；等更新、断档补课、同日互斥等规则见
> [ai-life-system.md §5.4.2](./ai-life-system.md#542-连续性事件进度节奏语义记忆四道闸新增)。
> 本节的「一次 +1 集 / 通宵 +2~4 集」与那张表必须一致。

- **anime_series** 追番 ｜ 45–120 ｜ indoor,rainy_ok,alone ｜ +0.2 ｜ 25% ｜ 看哪部、第几集、看到一半干了什么
- **anime_movie** 看剧场版 ｜ 100–140 ｜ indoor,alone ｜ +0.2 ｜ 20% ｜ 哪部剧场版、看哭了没有
- **anime_rewatch** 重温旧番 ｜ 45–90 ｜ indoor,rainy_ok ｜ +0.3 ｜ 30% ｜ 哪部、第几次重看、为什么突然想重看
- **anime_marathon** 通宵追番 ｜ 240–420 ｜ indoor,alone ｜ +0.4 ｜ 10% ｜ 追了几集、几点睡的（罕见，配合通宵配方）
- **bilibili_scroll** 刷视频 ｜ 30–90 ｜ indoor,tired_ok ｜ 0 ｜ 45% ｜ 刷到什么、笑没笑
- **novel_read** 看小说 ｜ 40–120 ｜ indoor,rainy_ok ｜ +0.2 ｜ 30% ｜ 什么书、看到哪、有没有划线
- **manga_read** 看漫画 ｜ 30–90 ｜ indoor ｜ +0.2 ｜ 30% ｜ 什么漫画、第几话

## 二、游戏（arc = game）

- **game_playthrough** 单机推进 ｜ 60–180 ｜ indoor,alone ｜ +0.3 ｜ 25% ｜ 什么游戏、推到哪、卡没卡
- **game_roguelike** 一局 Roguelike ｜ 30–90 ｜ indoor ｜ +0.2 ｜ 35% ｜ 死在第几层、用的什么流派
- **game_cozy** 种田/模拟经营 ｜ 45–120 ｜ indoor,rainy_ok ｜ +0.3 ｜ 35% ｜ 游戏名、今天种了什么/布置了哪个房间
- **game_mobile** 手游日常 ｜ 15–40 ｜ indoor,tired_ok ｜ 0 ｜ 50% ｜ 清日常、抽卡歪没歪
- **game_boss_retry** 死磕 Boss ｜ 45–120 ｜ indoor ｜ -0.1 ｜ 20% ｜ 打了几次、过没过、摔没摔手柄

## 三、兴趣与手工

- **draw** 画画 ｜ 40–120 ｜ indoor,alone ｜ +0.3 ｜ 30% ｜ 画了什么、手抖了没
- **journal_write** 写手账 ｜ 30–60 ｜ indoor,rainy_ok ｜ +0.2 ｜ 40% ｜ 记了什么、贴了什么
- **learn_guitar** 练琴 ｜ 30–60 ｜ indoor ｜ +0.2 ｜ 25% ｜ 练哪首、和弦按得疼不疼
- **learn_cook** 学新菜 ｜ 60–120 ｜ indoor ｜ +0.3 ｜ 35% ｜ 做什么、成功没、味道如何
- **plant_care** 照顾植物 ｜ 15–30 ｜ indoor ｜ +0.2 ｜ 50% ｜ 哪盆、长新叶了没
- **puzzle** 拼图/乐高 ｜ 60–180 ｜ indoor,rainy_ok ｜ +0.3 ｜ 30% ｜ 拼到哪、少没少块
- **photo_edit** 修照片 ｜ 30–60 ｜ indoor ｜ +0.1 ｜ 40% ｜ 修哪几张、调成什么色调

## 四、家务

- **clean_room** 打扫房间 ｜ 40–90 ｜ indoor ｜ -0.1 ｜ 35% ｜ 扫了什么、翻出什么旧东西
- **clean_deep** 大扫除 ｜ 120–240 ｜ indoor ｜ -0.2 ｜ 20% ｜ 洗了什么、扔了什么
- **laundry** 洗衣服 ｜ 20–40 ｜ indoor ｜ 0 ｜ 45% ｜ 洗了什么、晒了没
- **cook_meal** 做饭 ｜ 40–90 ｜ indoor ｜ +0.2 ｜ 35% ｜ 做什么菜、做砸了没
- **bake** 烘焙 ｜ 90–180 ｜ indoor ｜ +0.3 ｜ 25% ｜ 烤什么、糊了没
- **grocery** 去超市 ｜ 40–90 ｜ outdoor ｜ +0.1 ｜ 15% ｜ 买了什么、有没有多买零食
- **organize** 整理衣柜/书桌 ｜ 30–60 ｜ indoor ｜ -0.1 ｜ 40% ｜ 整理哪块、翻出什么
- **dishes** 洗碗 ｜ 15–30 ｜ indoor ｜ -0.1 ｜ 40% ｜ 洗了多少碗、懒了几小时
- **fix_thing** 修东西 ｜ 30–90 ｜ indoor ｜ 0 ｜ 30% ｜ 修什么、修好没

## 五、吃饭

- **meal_normal** 做饭/吃饭 ｜ 40–60 ｜ indoor ｜ +0.1 ｜ 50% ｜ 吃什么、一个人吃还是边看边吃
- **meal_takeout** 点外卖 ｜ 30–45 ｜ indoor,tired_ok ｜ 0 ｜ 55% ｜ 点什么、踩雷没
- **meal_snack** 下午茶/零食 ｜ 15–30 ｜ indoor ｜ +0.1 ｜ 55% ｜ 吃什么、配什么喝的
- **meal_night** 夜宵 ｜ 30–60 ｜ indoor ｜ +0.1 ｜ 45% ｜ 吃什么、几点吃的、吃完有没有后悔

## 六、出门

- **outing_mall** 逛街 ｜ 90–240 ｜ outdoor,rainy_ok ｜ +0.4 ｜ 15% ｜ 去哪逛、买了什么、试衣服了没
- **outing_cafe** 咖啡馆 ｜ 60–150 ｜ outdoor,rainy_ok ｜ +0.3 ｜ 20% ｜ 哪家店、喝什么、坐了多久
- **outing_bookstore** 书店 ｜ 60–120 ｜ outdoor,rainy_ok ｜ +0.3 ｜ 25% ｜ 哪家、翻了什么书、买了没
- **outing_supermarket** 超市采购 ｜ 40–90 ｜ outdoor ｜ 0 ｜ 20% ｜ 买了什么、提得动吗
- **outing_walk** 散步 ｜ 30–90 ｜ outdoor ｜ +0.2 ｜ 40% ｜ 走到哪、看到什么、天气如何
- **outing_park** 公园 ｜ 60–150 ｜ outdoor,sunny_only,hot_ok ｜ +0.3 ｜ 25% ｜ 哪个公园、看到什么、坐哪
- **outing_market** 菜市场/夜市 ｜ 45–120 ｜ outdoor ｜ +0.2 ｜ 25% ｜ 买了什么、砍价了没
- **outing_haircut** 剪头发 ｜ 60–120 ｜ outdoor ｜ +0.2 ｜ 10% ｜ 剪成什么样、后悔没
- **outing_pharmacy** 药店/便利店 ｜ 15–30 ｜ outdoor ｜ 0 ｜ 50% ｜ 买什么、因为哪里不舒服
- **outing_gym** 健身房 ｜ 60–90 ｜ outdoor ｜ +0.2 ｜ 15% ｜ 练什么、累不累
- **outing_swim** 游泳 ｜ 60–90 ｜ outdoor,hot_ok ｜ +0.3 ｜ 15% ｜ 游了多少、人多不多

## 七、近郊/短途（当天回）

- **short_trip_movie** 看电影 ｜ 120–180 ｜ outdoor,rainy_ok ｜ +0.3 ｜ 20% ｜ 什么片、哭没哭、旁边有人说话没
- **short_trip_museum** 博物馆/展 ｜ 120–240 ｜ outdoor,rainy_ok ｜ +0.3 ｜ 20% ｜ 什么展、看了多久、最喜欢哪件
- **short_trip_hike** 爬山/郊游 ｜ 180–360 ｜ outdoor,sunny_only ｜ +0.5 ｜ 15% ｜ 去哪座山、累不累、山顶什么样
- **short_trip_hotspring** 温泉 ｜ 180–300 ｜ outdoor,cold_ok ｜ +0.5 ｜ 15% ｜ 哪家、泡了多久、有没有下雪
- **short_trip_amusement** 游乐园 ｜ 240–420 ｜ outdoor,sunny_only ｜ +0.5 ｜ 15% ｜ 玩了什么、排多久、吓没吓到

## 八、在家躺着

- **idle_phone** 躺着刷手机 ｜ 30–90 ｜ indoor,tired_ok ｜ 0 ｜ 60% ｜ 刷什么、刷到几点
- **idle_nap** 午睡 ｜ 30–90 ｜ indoor ｜ +0.1 ｜ 5% ｜ 睡了多久、做梦没
- **idle_window** 看窗外发呆 ｜ 15–45 ｜ indoor ｜ +0.1 ｜ 55% ｜ 看到什么、在想什么
- **idle_music** 听歌 ｜ 30–60 ｜ indoor,tired_ok ｜ +0.2 ｜ 45% ｜ 听什么、哪首循环了
- **idle_bath** 泡澡 ｜ 30–60 ｜ indoor,cold_ok ｜ +0.3 ｜ 10% ｜ 泡了多久、加了什么
- **idle_shower** 洗澡 ｜ 20–30 ｜ indoor ｜ +0.1 ｜ 0%（不可打断） ｜ 洗头了没
- **idle_dress** 化妆/换衣服 ｜ 20–40 ｜ indoor ｜ +0.1 ｜ 10% ｜ 化什么妆、穿什么出门

## 九、天气/季节限定

- **rainy_window** 雨天听雨 ｜ 30–60 ｜ indoor,rainy_ok ｜ +0.2 ｜ 50% ｜ 雨多大、有没有开窗
- **snow_watch** 看雪 ｜ 20–40 ｜ indoor,cold_ok ｜ +0.4 ｜ 40% ｜ 雪大不大、有没有伸手接
- **sunny_balcony** 晒被子/晒太阳 ｜ 30–60 ｜ indoor,sunny_only ｜ +0.3 ｜ 40% ｜ 晒了什么、闻起来什么味
- **summer_ice** 做冰饮/吃冰 ｜ 20–40 ｜ indoor,hot_ok ｜ +0.3 ｜ 50% ｜ 做什么、甜不甜

## 十、社交（新增，设计约束见 ai-life-system.md 5.7）

朋友是**固定班底**（2–3 人，存在 `ai_people` 表里），名字永远不变，只在她的叙述里出现，不会变成第二个聊天对象。

- **call_friend** 和朋友打电话 ｜ 30–60 ｜ indoor ｜ +0.3 ｜ 30% ｜ 和谁、聊了什么、笑没笑
- **meal_friend** 和朋友吃饭 ｜ 90–150 ｜ outdoor ｜ +0.4 ｜ 10% ｜ 和谁、吃什么、聊到几点
- **outing_friend** 和朋友逛街 ｜ 120–240 ｜ outdoor ｜ +0.4 ｜ 10% ｜ 和谁、买了什么、谁付的钱
- **chat_friend** 和朋友发消息 ｜ 15–40 ｜ indoor,tired_ok ｜ +0.2 ｜ 50% ｜ 和谁、聊什么、有没有吐槽人
- **visit_friend** 朋友来家里 ｜ 120–240 ｜ indoor ｜ +0.4 ｜ 10% ｜ 谁来了、做了什么、几点走的
## 十一、特殊日配方（整天，优先级高于装填）

| id | 名称 | 触发 | 内容 | 约束 |
| --- | --- | --- | --- | --- |
| recipe_trip_day | 旅行日 | 抽中旅行 | 收拾 → 出发 → 到达 → 见闻 | 跨天，2–3 天 |
| recipe_homecoming | 回家日 | 旅行最后一天 | 返程 → 收拾 → 累瘫 | 当晚早睡 |
| recipe_sick | 生病日 | 2%/天，30 天冷却 | 全天在家、话少、心情低 | **仅 at_home=1 且当天无旅行** |
| recipe_deepclean | 大扫除日 | 1 次/月 | 全天分批打扫 | 心情先降后升 |
| recipe_marathon | 通宵追番日 | 1 次/月 | 晚上开始，睡到次日中午 | 次日不能有旅行 |
| recipe_festival | 节日/生日 | 从纪念日读 | 提前准备、发消息 | 可叠加在任意日 |
| recipe_lazy | 彻底摆烂日 | 3%/天 | 全天躺、外卖、不打扫 | 心情 +0.1（难得放松） |

## 冲突解决顺序（重要）

1. **旅行优先级最高**：占位期间不生成其他整天配方
2. 生病日只能落在 `at_home=1` 且前后 1 天没有旅行的日子
3. 通宵日次日不能是旅行首日（否则「她通宵完去旅行」很怪）
4. 大扫除日可被旅行挤掉，顺延到回家后
5. 节日可叠加，不冲突

## 数量核对

| 类别 | 条数 |
| --- | --- |
| 看番看剧 | 7 |
| 游戏 | 5 |
| 兴趣手工 | 7 |
| 家务 | 9 |
| 吃饭 | 4 |
| 出门 | 11 |
| 近郊短途 | 5 |
| 在家躺着 | 7 |
| 天气限定 | 4 |
| 社交 | 5 |
| **单元合计** | **64** |
| 特殊日配方 | 7 |

补足到 60 条的余量留给你加（比如「和朋友打电话」这类社交向的，加不加由你定）。
